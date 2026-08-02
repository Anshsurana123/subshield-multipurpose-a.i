/**
 * Product ordering engine — the "order me a gaming mouse within 2000 - 3000"
 * path routed here by the Purchase Director (category: product).
 *
 * Prava by default: there is NO cash/upi question — the product order mints a
 * Prava mandate session immediately and hands the user a 🔒 secure payment
 * link. Once they approve with a passkey, Prava grants a one-time credential
 * (network token + dynamic CVV) which we use to settle the merchant checkout.
 *
 * Execution chain (in order):
 *   1. Prava UCP discovery: searchViaUCP(productQuery) → productViaUCP →
 *      quoteViaUCP. This finds a REAL merchant (shopify store / amazon) and a
 *      quoted total, so the Prava session amount matches what we'll actually
 *      pay. The quote's merchant also seeds the vendor for the session.
 *   2. Browser Harness checkout with the granted credential (auto-buy's real
 *      contract) — used when a UCP quote is available.
 *   3. Steel merchant executor against the director's vendorUrl — fallback
 *      when UCP isn't configured but we have a product URL.
 *
 * Sandbox reality: if the agent isn't linked (no PRAVA_AGENT_ID) or the
 * harness isn't configured, we still mint the Prava session (user approves a
 * real passkey payment) and surface exactly where merchant execution stops.
 */
import { pravaClient } from './prava-client';
import { searchViaUCP, productViaUCP, quoteViaUCP, checkoutViaBrowserHarness, type UcpQuote } from './prava-ucp';
import { chatEmailForUser } from './utils';
import { FINALIZE_RE } from './food-order';
import type { FoodOrderContext } from './food-order';
import type { PurchasePlan } from './purchase-director';

// NOTE: `extractOneTimeCredential` (auto-buy) and `executeMerchantCheckout`
// (merchant-executor) pull in the heavy steel/playwright graph. They are
// imported DYNAMICALLY inside resolvePendingProductOrder so the chat webhook
// hot path (which imports this module) stays light — the codebase deliberately
// keeps steel out of chat handling (see utils.ts chatEmailForUser note).

interface PendingProductOrder {
  ctx: FoodOrderContext;
  plan: PurchasePlan;
  sessionId: string;
  amount: number;
  currency: string;
  vendorName: string;
  vendorDomain: string;
  /** UCP quote (when discovery succeeded) — enables harness checkout. */
  quote?: UcpQuote;
  /** Prava iframe URL for the user to approve the card payment (dashboard link). */
  paymentLink: string;
  /** Set once the user approved with a passkey (console shows real state). */
  approvedAt?: number;
  createdAt: number;
}

import { saveDurablePendingOrder, getDurablePendingOrder, deleteDurablePendingOrder } from './persistent-orders';

const pendingOrders = new Map<string, PendingProductOrder>();
const PENDING_TTL_MS = 30 * 60 * 1000;

async function getPendingOrder(chatId: string): Promise<PendingProductOrder | null> {
  const p = pendingOrders.get(chatId);
  if (p) {
    if (Date.now() - p.createdAt <= PENDING_TTL_MS) {
      return p;
    }
    pendingOrders.delete(chatId);
    await deleteDurablePendingOrder(chatId, 'product');
    return null;
  }
  const durable = await getDurablePendingOrder<PendingProductOrder>(chatId, 'product');
  if (durable) {
    pendingOrders.set(chatId, durable);
    return durable;
  }
  return null;
}

async function savePendingOrder(chatId: string, order: PendingProductOrder): Promise<void> {
  pendingOrders.set(chatId, order);
  await saveDurablePendingOrder(chatId, 'product', order);
}

async function removePendingOrder(chatId: string): Promise<void> {
  pendingOrders.delete(chatId);
  await deleteDurablePendingOrder(chatId, 'product');
}

/** Host of a URL (without www) for the Prava merchant domain field. */
function hostOf(url: string | null | undefined): string {
  if (!url) return 'shopify.com';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] || 'shopify.com';
  }
}

/**
 * Try to discover a real product + quote via Prava UCP. Returns the quote, or
 * null when the agent isn't linked / nothing matched / discovery threw.
 */
async function discoverQuote(plan: PurchasePlan): Promise<UcpQuote | null> {
  try {
    const shipsTo = plan.currency === 'INR' ? 'IN' : plan.currency === 'USD' ? 'US' : undefined;
    const results = await searchViaUCP(plan.productQuery, { limit: 10, shipsTo });
    if (!results.length) return null;

    // Prefer a result within the user's price range when one was given.
    const withinRange =
      plan.minPrice != null || plan.maxPrice != null
        ? results.filter((r) => {
            const est = r.priceEstimate?.amount;
            if (est == null) return true; // no estimate — don't rule out
            if (plan.minPrice != null && est < plan.minPrice) return false;
            if (plan.maxPrice != null && est > plan.maxPrice) return false;
            return true;
          })
        : results;
    const pool = withinRange.length ? withinRange : results;
    const match = pool[0];
    if (!match) return null;

    const product = await productViaUCP(match.productId, match.merchant);
    const variants = (product?.variants ?? []).filter((v: any) => v.available !== false);
    const variant = variants[0];
    if (!variant) return null;

    return await quoteViaUCP({
      variantId: variant.id,
      merchant: variant.merchantDomain || match.merchant,
      quantity: 1,
    });
  } catch (err: any) {
    console.warn('[ProductOrder] UCP discovery failed:', err?.message || err);
    return null;
  }
}

/** Estimate the session amount when no quote is available. */
function estimateAmount(plan: PurchasePlan): number {
  if (plan.minPrice != null && plan.maxPrice != null) {
    return Math.round(((plan.minPrice + plan.maxPrice) / 2) * 100) / 100;
  }
  if (plan.maxPrice != null) return plan.maxPrice;
  if (plan.minPrice != null) return plan.minPrice;
  if (plan.estimatedPrice != null) return plan.estimatedPrice;
  return plan.currency === 'USD' ? 29.99 : 1499; // Realistic default baseline estimate (e.g. ₹1,499)
}

/** Price display for the plan (used in replies). */
function priceLabel(plan: PurchasePlan): string {
  if (plan.minPrice != null && plan.maxPrice != null) return `${plan.minPrice} - ${plan.maxPrice}`;
  if (plan.minPrice != null) return `min ${plan.minPrice}`;
  if (plan.maxPrice != null) return `under ${plan.maxPrice}`;
  if (plan.estimatedPrice != null) return `~${plan.estimatedPrice}`;
  return 'best price';
}

/**
 * Start a product order: discover a quote (UCP) → mint the Prava session →
 * park a pending order → return the secure-link reply.
 */
export async function orderProductFromChat(plan: PurchasePlan, ctx: FoodOrderContext): Promise<string> {
  const query = plan.productQuery || plan.items[0]?.name || 'product';
  const quote = await discoverQuote(plan);

  const amount = quote?.finalPrice?.amount ?? estimateAmount(plan);
  const currency = quote?.finalPrice?.currency || plan.currency || 'INR';
  const vendorName = quote?.merchant || (plan.vendorUrl ? hostOf(plan.vendorUrl).split('.')[0] : (plan.merchant === 'amazon' ? 'Amazon' : 'Shopify Store'));
  const vendorDomain = plan.vendorUrl ? hostOf(plan.vendorUrl) : (plan.merchant === 'amazon' ? 'amazon.in' : 'shopify.com');

  try {
    const session = await pravaClient.createMandateSession({
      userId: ctx.userId,
      userEmail: chatEmailForUser(ctx.userId),
      vendorName,
      vendorDomain,
      amount,
      currency,
      description: `Product order: ${query}${plan.minPrice != null || plan.maxPrice != null ? ` (${priceLabel(plan)})` : ''}`,
    });

    const pending: PendingProductOrder = {
      ctx,
      plan,
      sessionId: session.sessionId,
      amount,
      currency,
      vendorName,
      vendorDomain,
      ...(quote ? { quote } : {}),
      paymentLink: session.iframeUrl,
      createdAt: Date.now(),
    };
    await savePendingOrder(ctx.chatId, pending);

    const lines = [
      `🛍️ *Product order — ready for secure payment*`,
      ``,
      `🔍 *Looking for*: ${query}`,
      `🏪 *Merchant*: ${vendorName} (${vendorDomain})`,
      quote
        ? `💰 *Quoted total*: ${currency} ${amount.toFixed(2)}`
        : `💰 *Estimated*: ${currency} ${amount.toFixed(2)}${plan.minPrice != null || plan.maxPrice != null ? ` (target ${priceLabel(plan)})` : ''}`,
      ``,
      `💳 *Pay by card via Prava — secure link*`,
      ``,
      `🔒 Approve the payment here (your card stays in Prava's vault — never in chat):`,
      session.iframeUrl,
      ``,
      `Once you've approved, reply **done** and I'll complete the purchase.`,
    ];
    return lines.join('\n');
  } catch (err: any) {
    return `❌ Couldn't start the Prava payment: ${err?.message || err}`;
  }
}

/**
 * Handle a follow-up reply for a pending product order:
 *  - "done"/"approved"/"paid" → poll Prava → get credential → merchant checkout
 *  - "cancel"                 → drop the pending order
 * Returns null when the message is NOT an answer to a pending product order.
 */
export async function resolvePendingProductOrder(chatId: string, text: string): Promise<string | null> {
  const pending = await getPendingOrder(chatId);
  if (!pending) return null;

  const t = text.trim().toLowerCase();

  if (/^\s*(?:cancel|never mind|forget|drop it|nevermind)[.!]*\s*$/i.test(t)) {
    await removePendingOrder(chatId);
    return `🚫 Product order cancelled.`;
  }

  if (!FINALIZE_RE.test(t)) return null;

  const sessionId = pending.sessionId;

  // Poll briefly for the Prava result — approved once we see the one-time
  // credential (awaiting_result) or a closed session.
  let status = 'pending';
  let raw: any = null;
  for (let i = 0; i < 8; i++) {
    try {
      raw = await pravaClient.fetchRawPaymentResultForExecutor(sessionId);
      status = raw?.status || 'pending';
      if (status === 'awaiting_result' || status === 'completed' || status === 'failed') break;
    } catch { /* transient poll error — retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (status === 'failed') {
    await removePendingOrder(chatId);
    return `❌ *Prava payment failed.*\n\nYour product order was not placed. Say the order again to retry.`;
  }
  if (status !== 'awaiting_result' && status !== 'completed') {
    return `⏳ I haven't seen your Prava approval yet. Open the secure link and approve it, then reply **done** again.`;
  }

  // Heavy deps (steel/playwright) loaded lazily — only when a merchant
  // checkout actually needs to run, not on every chat message.
  const [{ extractOneTimeCredential }, { executeMerchantCheckout }] = await Promise.all([
    import('./auto-buy'),
    import('./merchant-executor'),
  ]);

  const cred = extractOneTimeCredential(raw);

  // Execution: harness checkout when we have a UCP quote, else Steel executor
  // against the director's vendor URL, else honest fallback message.
  if (pending.quote && cred) {
    const harness = await checkoutViaBrowserHarness(pending.quote, {
      token: cred.credential.pan,
      cryptogram: cred.credential.cvv,
      expiryMonth: cred.credential.expiryMonth,
      expiryYear: cred.credential.expiryYear,
    });
    if (harness.status === 'completed' || harness.status === 'reconciled') {
      await pravaClient.reportTransactionStatus(sessionId, {
        txnRefId: cred.txnRefId,
        txnStatus: 'APPROVED',
        amountPaid: cred.amount || pending.amount.toFixed(2),
        authorizationCode: harness.orderReference || 'AUTHOK',
        responseCode: '00',
      }).catch((e) => console.warn('[ProductOrder] report APPROVED failed:', e));
      await removePendingOrder(chatId);
      return `✅ *Prava payment approved & merchant checkout completed!*\n\n${harness.detail}${harness.orderReference ? `\n🧾 ${harness.orderReference}` : ''}`;
    }
    // Harness failed — report DECLINED so Prava closes the session honestly.
    await pravaClient.reportTransactionStatus(sessionId, {
      txnRefId: cred.txnRefId,
      txnStatus: 'DECLINED',
      amountPaid: cred.amount || pending.amount.toFixed(2),
      responseCode: '05',
    }).catch((e) => console.warn('[ProductOrder] report DECLINED failed:', e));
    await removePendingOrder(chatId);
    return `⚠️ *Prava payment approved, but the merchant checkout didn't complete.*\n\n${harness.detail}\n\nYour card was NOT charged on the merchant side. Try the order again.`;
  }

  if (cred && pending.plan.vendorUrl) {
    // Steel fallback — fill the one-time token at the merchant's own site.
    const outcome = await executeMerchantCheckout(pending.plan.vendorUrl, cred.credential, {
      amount: pending.amount,
      currency: pending.currency,
    });
    if (outcome.status === 'approved') {
      await pravaClient.reportTransactionStatus(sessionId, {
        txnRefId: cred.txnRefId,
        txnStatus: 'APPROVED',
        amountPaid: cred.amount || pending.amount.toFixed(2),
        authorizationCode: outcome.orderReference || 'AUTHOK',
        responseCode: '00',
      }).catch((e) => console.warn('[ProductOrder] report APPROVED failed:', e));
      await removePendingOrder(chatId);
      return `✅ *Prava payment approved & order placed!*\n\n${outcome.detail}${outcome.orderReference ? `\n🧾 ${outcome.orderReference}` : ''}`;
    }
    await pravaClient.reportTransactionStatus(sessionId, {
      txnRefId: cred.txnRefId,
      txnStatus: 'DECLINED',
      amountPaid: cred.amount || pending.amount.toFixed(2),
      responseCode: '05',
    }).catch((e) => console.warn('[ProductOrder] report DECLINED failed:', e));
    await removePendingOrder(chatId);
    return `⚠️ *Prava payment approved, but the merchant rejected the checkout.*\n\n${outcome.detail}`;
  }

  // Approved but no executable merchant path (UCP not configured, no URL).
  // Keep the pending entry alive so the user can reply "done" again once
  // merchant execution gets configured — approval already happened on Prava.
  pending.approvedAt = Date.now();
  await savePendingOrder(chatId, pending);
  return (
    `✅ *Prava payment approved!*\n\n` +
    `💰 *Amount*: ${pending.currency} ${pending.amount.toFixed(2)}\n` +
    `🏪 *Merchant*: ${pending.vendorName} (${pending.vendorDomain})\n\n` +
    `⚠️ Merchant execution isn't configured on this instance yet (link the Prava agent with \`prava setup\` and set PRAVA_AGENT_ID / PRAVA_AGENT_PRIVATE_KEY to enable automated checkout).\n\n` +
    `Your payment was authorized with Prava. Reply **done** again once execution is configured, or finish it directly at:\n${pending.plan.vendorUrl || `https://${pending.vendorDomain}`}`
  );
}

// ─── Dashboard console snapshot ──────────────────────────────────────────────

export interface PendingProductOrderSummary {
  engine: 'product';
  chatId: string;
  userId: string;
  channel: string;
  productQuery: string;
  vendorName: string;
  vendorDomain: string;
  amount: number;
  currency: string;
  hasQuote: boolean;
  sessionId: string;
  paymentLink: string;
  createdAt: number;
  ageSeconds: number;
  /** Human status for the console. */
  status: 'awaiting_prava_approval' | 'approved_pending_execution';
}

/** Snapshot live pending product orders (serializable, oldest first). */
export function listPendingProductOrders(): PendingProductOrderSummary[] {
  const out: PendingProductOrderSummary[] = [];
  const now = Date.now();
  for (const [chatId, p] of pendingOrders) {
    if (now - p.createdAt > PENDING_TTL_MS) {
      pendingOrders.delete(chatId); // evict stale entries while listing
      continue;
    }
    out.push({
      engine: 'product',
      chatId,
      userId: p.ctx.userId,
      channel: p.ctx.channel,
      productQuery: p.plan.productQuery || p.plan.items[0]?.name || 'product',
      vendorName: p.vendorName,
      vendorDomain: p.vendorDomain,
      amount: p.amount,
      currency: p.currency,
      hasQuote: !!p.quote,
      sessionId: p.sessionId,
      paymentLink: p.paymentLink,
      createdAt: p.createdAt,
      ageSeconds: Math.floor((now - p.createdAt) / 1000),
      status: p.approvedAt ? 'approved_pending_execution' : 'awaiting_prava_approval',
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

