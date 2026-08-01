import { TrackedProduct } from './types';
import { supabaseAdmin } from './supabase/server';
import { sendPushNotification } from './push-notifications';
import { scrapeLivePrice } from './product-scraper';
import { sendChatMessage } from './chat-senders';
import { formatPrice } from './chat-intent';
import { startAutoBuy, executeAutoBuy } from './auto-buy';
import type { ChatChannel } from './types';

// In-memory fallback cache
const memoryTrackedProducts: TrackedProduct[] = [];

function stripUrlParams(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export async function addTrackedProduct(params: {
  userId?: string;
  productUrl: string;
  productName?: string;
  targetPrice: number;
  currency?: string;
  channel?: ChatChannel | 'web';
  chatId?: string;
}): Promise<TrackedProduct> {
  const userId = params.userId || 'demo-user-id';
  let productName = params.productName || 'Tracked Product';
  let currentPrice = params.targetPrice * 1.15; // Initial default estimate before scan
  const currency = params.currency || 'USD';

  // Try scraping initial product details (title + live price) via Steel
  try {
    if (process.env.STEEL_API_KEY) {
      console.log(`[PriceTracker] Fetching product details via Steel: ${params.productUrl}`);
      const scraped = await scrapeLivePrice(params.productUrl);
      if (scraped.title && !params.productName) {
        productName = scraped.title.substring(0, 60);
      }
      if (scraped.price !== null) {
        currentPrice = scraped.price;
      }
    }
  } catch (err) {
    console.warn('[PriceTracker] Initial scrap warning:', err);
  }

  const product: TrackedProduct = {
    id: `prod_${Math.random().toString(36).substring(2, 9)}`,
    userId,
    productUrl: stripUrlParams(params.productUrl),
    productName,
    currentPrice,
    targetPrice: params.targetPrice,
    currency,
    status: 'active',
    lastScannedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceChannel: params.channel,
    sourceChatId: params.chatId,
  };

  // Save to Supabase if table exists, otherwise in-memory
  try {
    await supabaseAdmin.from('tracked_products').insert({
      id: product.id,
      user_id: product.userId,
      product_url: product.productUrl,
      product_name: product.productName,
      current_price: product.currentPrice,
      target_price: product.targetPrice,
      currency: product.currency,
      status: product.status,
      source_channel: product.sourceChannel || null,
      source_chat_id: product.sourceChatId || null,
    });
  } catch (dbErr) {
    console.warn('[PriceTracker] Database insert fallback to memory:', dbErr);
    memoryTrackedProducts.push(product);
  }

  return product;
}

export async function getTrackedProducts(userId = 'demo-user-id'): Promise<TrackedProduct[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('tracked_products')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (!error && data) {
      return data.map(mapRowToProduct);
    }
  } catch { /* DB fallback */ }

  return memoryTrackedProducts.filter((p) => p.userId === userId);
}

/** Fetch every tracked product across all users (used by the cron scanner). */
export async function getAllTrackedProducts(): Promise<TrackedProduct[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from('tracked_products')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      return data.map(mapRowToProduct);
    }
  } catch { /* DB fallback */ }

  return [...memoryTrackedProducts];
}

function mapRowToProduct(d: any): TrackedProduct {
  return {
    id: d.id,
    userId: d.user_id,
    productUrl: d.product_url,
    productName: d.product_name,
    currentPrice: Number(d.current_price),
    targetPrice: Number(d.target_price),
    currency: d.currency || 'USD',
    status: d.status,
    lastScannedAt: d.last_scanned_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    sourceChannel: d.source_channel || undefined,
    sourceChatId: d.source_chat_id || undefined,
    pravaSessionId: d.prava_session_id || undefined,
  };
}

async function persistProductUpdate(id: string, patch: Record<string, unknown>): Promise<void> {
  try {
    await supabaseAdmin.from('tracked_products').update(patch).eq('id', id);
  } catch (err) {
    console.warn('[PriceTracker] DB update fallback (in-memory only):', err);
  }
}

async function notifyChat(item: TrackedProduct, message: string): Promise<void> {
  if (item.sourceChannel && item.sourceChatId) {
    await sendChatMessage(item.sourceChannel, item.sourceChatId, message);
  }
}

/**
 * Step 1 — live price check for an ACTIVE product. If the target is hit,
 * start a Prava session and transition to `target_reached` (awaiting the
 * user's passkey approval).
 */
async function checkAndStartBuy(item: TrackedProduct): Promise<{ started: boolean; livePrice: number | null }> {
  console.log(`[PriceTracker] Scanning price for ${item.productName}...`);

  let livePrice: number | null = null;
  try {
    const scraped = await scrapeLivePrice(item.productUrl);
    livePrice = scraped.price;
    if (scraped.title && scraped.title !== 'Tracked Product') {
      await persistProductUpdate(item.id, { product_name: scraped.title.substring(0, 60) });
    }
  } catch (err) {
    console.warn(`[PriceTracker] Scrape failed for ${item.productName}:`, err);
  }

  if (livePrice === null) {
    console.warn(`[PriceTracker] No live price for ${item.productName} — skipping (fail-safe, no purchase).`);
    return { started: false, livePrice: null };
  }

  await persistProductUpdate(item.id, {
    current_price: livePrice,
    last_scanned_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (livePrice > item.targetPrice) {
    console.log(`[PriceTracker] ${item.productName} still ${formatPrice(livePrice, item.currency)} > target ${formatPrice(item.targetPrice, item.currency)}. Keep monitoring.`);
    return { started: false, livePrice };
  }

  // 🎯 Target hit — start the Prava buy order
  console.log(`🎯 [PriceTracker] Price target hit for ${item.productName}! (${formatPrice(livePrice, item.currency)} <= ${formatPrice(item.targetPrice, item.currency)})`);

  try {
    // callback_url: Prava redirects here the moment the user approves with a
    // passkey, so the buy executes immediately instead of waiting for the
    // next (daily, on Hobby) cron run. The URL carries the owning userId (so
    // chat-enrolled products resolve) plus an HMAC so the unauthenticated
    // redirect can't be replayed to trigger purchases for arbitrary items.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
    const secret = process.env.CRON_SECRET || 'subshield_cron_secret_key_2026';
    const token = await crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(`${item.id}:${secret}`))
      .then((buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''));
    const callbackUrl = appUrl
      ? `${appUrl}/api/prava/execute-buy?productId=${encodeURIComponent(item.id)}&userId=${encodeURIComponent(item.userId)}&cb=${token}`
      : undefined;
    const started = await startAutoBuy(item, callbackUrl);
    item.status = 'target_reached';
    item.pravaSessionId = started.sessionId;
    await persistProductUpdate(item.id, {
      status: 'target_reached',
      prava_session_id: started.sessionId,
      current_price: livePrice,
      updated_at: new Date().toISOString(),
    });

    await notifyChat(
      item,
      `🎉 *Target Price Hit!*\n\n` +
      `📦 ${item.productName}\n` +
      `💰 Price dropped to ${formatPrice(livePrice, item.currency)} (target: ${formatPrice(item.targetPrice, item.currency)})\n\n` +
      `✅ Prava buy order started. Approve the payment here:\n${started.paymentLink || ''}`
    );

    await sendPushNotification(
      item.userId,
      `🎉 Target Price Hit: ${item.productName}!`,
      `Price dropped to ${formatPrice(livePrice, item.currency)} (Target: ${formatPrice(item.targetPrice, item.currency)}). Approve the Prava payment to complete your auto-purchase!`,
      'switch_suggestion'
    );

    return { started: true, livePrice };
  } catch (err) {
    console.error(`[PriceTracker] Failed to start Prava buy order for ${item.productName}:`, err);
    return { started: false, livePrice };
  }
}

/**
 * Step 2 — for a `target_reached` product with an open session, poll for the
 * user's passkey approval, execute the real merchant checkout, and report the
 * outcome to Prava. On success transition to `purchased`.
 */
async function finishBuy(item: TrackedProduct): Promise<{ purchased: boolean }> {
  if (!item.pravaSessionId) return { purchased: false };

  console.log(`[PriceTracker] Awaiting approval & executing purchase for ${item.productName} (session ${item.pravaSessionId})...`);
  const result = await executeAutoBuy(item, item.pravaSessionId);

  if (result.status === 'reported' || result.status === 'completed') {
    item.status = 'purchased';
    await persistProductUpdate(item.id, { status: 'purchased', updated_at: new Date().toISOString() });

    await notifyChat(
      item,
      `✅ *Purchase Complete!*\n\n` +
      `📦 ${item.productName}\n` +
      `🧾 ${result.orderReference ? `Order: ${result.orderReference}\n` : ''}${result.detail}`
    );
    return { purchased: true };
  }

  if (result.status === 'declined' || result.status === 'failed') {
    await notifyChat(
      item,
      `⚠️ *Purchase attempt did not complete.*\n\n📦 ${item.productName}\n${result.detail}\n\nI'll keep monitoring for another chance.`
    );
    // Return to active monitoring so the target can be re-hit.
    item.status = 'active';
    await persistProductUpdate(item.id, { status: 'active', updated_at: new Date().toISOString() });
    return { purchased: false };
  }

  // pending_approval — user hasn't approved yet; keep waiting.
  return { purchased: false };
}

export async function scanAndBuyTrackedProducts(userId = 'demo-user-id'): Promise<{ scanned: number; purchased: number }> {
  const products = await getTrackedProducts(userId);
  let scanned = 0;
  let purchased = 0;

  for (const item of products) {
    if (item.status === 'active') {
      scanned++;
      await checkAndStartBuy(item);
    } else if (item.status === 'target_reached') {
      const res = await finishBuy(item);
      if (res.purchased) purchased++;
    }
  }

  return { scanned, purchased };
}

/** Scan every tracked product for every user — used by the cron price-scan route. */
export async function scanAndBuyAllTrackedProducts(): Promise<{ scanned: number; purchased: number }> {
  const products = await getAllTrackedProducts();
  let scanned = 0;
  let purchased = 0;

  for (const item of products) {
    if (item.status === 'active') {
      scanned++;
      await checkAndStartBuy(item);
    } else if (item.status === 'target_reached') {
      const res = await finishBuy(item);
      if (res.purchased) purchased++;
    }
  }

  return { scanned, purchased };
}
