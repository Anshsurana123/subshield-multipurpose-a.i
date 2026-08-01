import { NextResponse } from 'next/server';
import { getTrackedProducts } from '@/lib/price-tracker';
import { runAutoBuy, executeAutoBuy } from '@/lib/auto-buy';

export const dynamic = 'force-dynamic';
// Hobby plan caps serverless functions at 60s. executeAutoBuy's default poll
// budget (~30s) + merchant call fits comfortably.
export const maxDuration = 60;

/**
 * POST /api/prava/execute-buy
 * Body: { productId, userId?, executePayment?: boolean }
 *
 * GET  /api/prava/execute-buy?productId=...&userId=...
 * Used as the Prava callback_url — the iframe redirects here the moment the
 * user approves with a passkey, so execution starts immediately rather than
 * waiting for the next (daily, on Hobby) cron run.
 *
 * Manually drive the auto-buy flow for one tracked product:
 *  - if 'active' (or no open session): start a Prava session (and, if
 *    executePayment=true, poll + pay at the merchant).
 *  - if 'target_reached' with a session id: resume execution.
 */
async function handle(productId: string | null, userId: string, executePayment: boolean) {
  if (!productId) {
    return NextResponse.json({ error: 'productId is required' }, { status: 400 });
  }

  const products = await getTrackedProducts(userId);
  const product = products.find((p) => p.id === productId);

  if (!product) {
    return NextResponse.json({ error: 'Tracked product not found' }, { status: 404 });
  }

  let result;
  if (product.status === 'target_reached' && product.pravaSessionId) {
    result = await executeAutoBuy(product, product.pravaSessionId);
  } else {
    result = await runAutoBuy(product, { executePayment });
  }

  return NextResponse.json({ success: true, productId, result });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { productId, userId = 'demo-user-id', executePayment = true } = body;
    return await handle(productId, userId, executePayment);
  } catch (error: any) {
    console.error('[ExecuteBuy] Error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to run auto-buy' }, { status: 500 });
  }
}

/** Prava callback redirect after passkey approval. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get('productId');
    const userId = url.searchParams.get('userId') || 'demo-user-id';

    // The callback URL is exposed to the browser (iframe redirect, analytics,
    // logs), so it must not be replayable to trigger purchases for arbitrary
    // items. Validate HMAC(productId, CRON_SECRET) — matches the token built
    // in price-tracker's callbackUrl.
    const cb = url.searchParams.get('cb') || '';
    const secret = process.env.CRON_SECRET || 'subshield_cron_secret_key_2026';
    const expected = await crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(`${productId}:${secret}`))
      .then((buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''));
    if (!productId || cb !== expected) {
      return NextResponse.json({ error: 'Invalid callback token' }, { status: 401 });
    }

    // Callback fires after the user already approved → execute immediately.
    // Replay-safe: the callback may ONLY resume a product that already has a
    // pending Prava session (status 'target_reached'). It must never start a
    // new buy — otherwise a captured callback URL replayed after the product
    // is purchased would trigger a second purchase.
    const products = await getTrackedProducts(userId);
    const product = products.find((p) => p.id === productId);
    if (!product) {
      return NextResponse.json({ success: false, error: 'Tracked product not found' }, { status: 404 });
    }
    if (product.status !== 'target_reached' || !product.pravaSessionId) {
      // Idempotent: already purchased / no pending session — never re-buy.
      return NextResponse.json({ success: true, status: 'idle', productId });
    }
    const result = await executeAutoBuy(product, product.pravaSessionId);
    return NextResponse.json({ success: true, productId, result });
  } catch (error: any) {
    console.error('[ExecuteBuy] Callback error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Failed to run auto-buy' }, { status: 500 });
  }
}
