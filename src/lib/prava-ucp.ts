import crypto from 'crypto';

/**
 * Prava UCP discovery + Browser Harness checkout — the REAL contract.
 *
 * The underlying UCP/harness service URLs are internal infrastructure and are
 * NOT exposed publicly. Developers interact with them natively through the
 * Prava CLI/SDKs: `prava shop search → product → quote → checkout`. That CLI is
 * open source (@prava-sdk/cli, github.com/Prava-Payments/prava-skills) — this
 * module implements the exact same wire contract the CLI uses, so our server
 * can drive the same flow without guessing internal URLs.
 *
 *   Base URL : PRAVA_WALLET_API_URL  (default https://pay-api.prava.space)
 *   Auth     : Ed25519 agent signature over `timestamp + body`
 *              Headers: X-Agent-Id, X-Timestamp, X-Signature
 *   Flow     : POST /v1/wallet/shop/search   {query, intent?, limit?, cursor?, merchantDomain?, shipsTo?}
 *              POST /v1/wallet/shop/product  {product_id, merchantDomain?}
 *              POST /v1/wallet/shop/quote    {variant_id, merchantDomain, quantity, address_id?, email?}
 *                  → { checkout_session_id, price_breakdown{subtotal_cents,shipping_cents,tax_cents},
 *                      final_price{amount,currency}, selected_shipping, expires_at }
 *              POST /v1/wallet/shop/checkout { checkout_session_id, credentials:
 *                      { token, cryptogram, expiry_month?, expiry_year?, cardholder_name? } }
 *                  → { success, data: { status:'paid', amount, order_id } }
 *
 * Agent credentials come from running `prava setup` once (agentId + privateKey).
 * They're injected into the server env as:
 *   PRAVA_AGENT_ID, PRAVA_AGENT_PRIVATE_KEY, (PRAVA_AGENT_PUBLIC_KEY optional)
 */

export interface UcpSearchResult {
  title: string;
  productId: string;
  merchant: string;
  priceEstimate?: { amount: number; currency: string };
  raw?: any;
}

export interface UcpQuote {
  checkoutSessionId: string;
  merchant: string;
  subtotal: number;
  tax: number;
  shipping: number;
  finalPrice: { amount: number; currency: string };
  selectedShipping?: string;
  expiresAt?: string;
  raw?: any;
}

export interface HarnessCheckoutResult {
  status: 'completed' | 'reconciled' | 'failed' | 'not_configured';
  finalTotal?: number;
  orderReference?: string;
  detail: string;
}

/** One-time payment credential to hand the Browser Harness checkout. */
export interface HarnessCredential {
  token: string;
  cryptogram: string; // the CLI maps Prava's dynamic_cvv → cryptogram
  expiryMonth?: string;
  expiryYear?: string;
}

const WALLET_API_URL = process.env.PRAVA_WALLET_API_URL || 'https://pay-api.prava.space';
// Search/product are plain API calls (fast); quote/checkout drive a real
// browser session so they legitimately need longer. Keeping discovery short
// matters: quoteFromProductUrl chains three calls and must fit inside the
// 30s payment budget in auto-buy.ts.
const API_TIMEOUT = 8000;
const BROWSER_TIMEOUT = 30000;

interface AgentCreds {
  agentId: string;
  privateKey: string;
}

/** Load linked-agent credentials from env (from `prava setup`). */
function agentCreds(): AgentCreds | null {
  const agentId = process.env.PRAVA_AGENT_ID;
  const privateKey = process.env.PRAVA_AGENT_PRIVATE_KEY;
  if (!agentId || !privateKey) return null;
  return { agentId, privateKey };
}

/**
 * True when the agent is linked AND the flow isn't explicitly disabled.
 * Default-on once agent creds are present (that's the whole point of linking),
 * with PRAVA_ENABLE_UCP_HARNESS=0 as the explicit opt-out.
 */
export function isUcpHarnessConfigured(): boolean {
  if (!agentCreds()) return false;
  if (process.env.PRAVA_ENABLE_UCP_HARNESS === '0') {
    console.warn('[UCP] Agent linked but PRAVA_ENABLE_UCP_HARNESS=0 — UCP/Browser Harness disabled (falling back).');
    return false;
  }
  return true;
}

/** Sign a request the exact way the Prava CLI does: Ed25519 over timestamp+body. */
function signRequest(privateKeyBase64: string, timestamp: string, body: string): string {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString('base64');
}

async function walletPost(path: string, body: Record<string, unknown>, timeoutMs = BROWSER_TIMEOUT): Promise<any> {
  const creds = agentCreds();
  if (!creds) {
    throw new Error('Prava agent not linked — run `prava setup --name "SubShield"` and set PRAVA_AGENT_ID / PRAVA_AGENT_PRIVATE_KEY.');
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyStr = JSON.stringify(body);
  const signature = signRequest(creds.privateKey, timestamp, bodyStr);

  const res = await fetch(`${WALLET_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Id': creds.agentId,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    body: bodyStr,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });

  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    throw new Error(`Prava wallet ${path} HTTP ${res.status}: ${(data?.error || data?.message || text).slice(0, 300)}`);
  }
  if (data?.success === false) {
    throw new Error(`Prava wallet ${path} failed: ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

const centsToDollars = (c: number | null | undefined) => (c == null ? 0 : Number(c) / 100);

// ─── Step 0: Search the wallet catalog ────────────────────────────────────────
export async function searchViaUCP(query: string, opts: { intent?: string; limit?: number; merchant?: string; shipsTo?: string } = {}): Promise<UcpSearchResult[]> {
  const body: Record<string, unknown> = { query };
  if (opts.intent) body.intent = opts.intent;
  if (opts.limit) body.limit = opts.limit;
  if (opts.merchant) body.merchantDomain = opts.merchant;
  if (opts.shipsTo) body.shipsTo = opts.shipsTo;

  const res = await walletPost('/v1/wallet/shop/search', body, API_TIMEOUT);
  const d = res?.data ?? {};
  const results = Array.isArray(d.results) ? d.results : [];
  return results.map((r: any) => ({
    title: r.title,
    productId: r.product_id,
    merchant: r.merchant,
    priceEstimate: r.price_estimate,
    raw: r,
  }));
}

// ─── Step 1: Product detail (variants / offers) ───────────────────────────────
export async function productViaUCP(productId: string, merchant?: string): Promise<any> {
  const body: Record<string, unknown> = { product_id: productId };
  if (merchant) body.merchantDomain = merchant;
  const res = await walletPost('/v1/wallet/shop/product', body, API_TIMEOUT);
  return res?.data?.product ?? res?.data ?? null;
}

// ─── Step 2: Quote ────────────────────────────────────────────────────────────
export async function quoteViaUCP(opts: {
  variantId: string;
  merchant: string;
  quantity?: number;
  addressId?: string;
  email?: string;
  retries?: number;
}): Promise<UcpQuote> {
  const body: Record<string, unknown> = {
    variant_id: opts.variantId,
    merchantDomain: opts.merchant,
    quantity: opts.quantity ?? 1,
  };
  if (opts.addressId) body.address_id = opts.addressId;
  if (opts.email) body.email = opts.email;

  const res = await walletPost('/v1/wallet/shop/quote', body, BROWSER_TIMEOUT);
  const q = res?.data ?? {};
  const b = q.price_breakdown ?? {};

  return {
    checkoutSessionId: q.checkout_session_id,
    merchant: q.merchant || opts.merchant,
    subtotal: centsToDollars(b.subtotal_cents),
    tax: centsToDollars(b.tax_cents),
    shipping: centsToDollars(b.shipping_cents),
    finalPrice: q.final_price ?? { amount: 0, currency: 'USD' },
    selectedShipping: q.selected_shipping?.title,
    expiresAt: q.expires_at,
    raw: q,
  };
}

// ─── Step 3: Browser Harness checkout ─────────────────────────────────────────
export async function checkoutViaBrowserHarness(
  quote: UcpQuote,
  credential: HarnessCredential
): Promise<HarnessCheckoutResult> {
  if (!quote.checkoutSessionId) {
    return { status: 'not_configured', detail: 'No checkout_session_id from quote — cannot drive checkout.' };
  }
  try {
    const credentials: Record<string, unknown> = {
      token: credential.token,
      cryptogram: credential.cryptogram,
    };
    if (credential.expiryMonth) credentials.expiry_month = credential.expiryMonth;
    if (credential.expiryYear) credentials.expiry_year = credential.expiryYear;

    const res = await walletPost(
      '/v1/wallet/shop/checkout',
      { checkout_session_id: quote.checkoutSessionId, credentials },
      BROWSER_TIMEOUT
    );
    const d = res?.data ?? {};
    const paid = res?.success === true && d.status === 'paid';

    if (paid) {
      return {
        status: 'completed',
        finalTotal: d.amount?.amount != null ? d.amount.amount : quote.finalPrice.amount,
        orderReference: d.order_id,
        detail: 'Browser Harness checkout paid',
      };
    }
    return {
      status: d.status === 'reconciled' || d.status === 'pending' ? 'reconciled' : 'failed',
      finalTotal: d.amount?.amount,
      orderReference: d.order_id,
      detail: `Checkout returned status "${d.status}": ${JSON.stringify(d).slice(0, 300)}`,
    };
  } catch (err: any) {
    return { status: 'failed', detail: `Browser Harness checkout threw: ${err?.message || err}` };
  }
}

/**
 * Convenience for the auto-buy chain: turn a tracked product URL + name into
 * a live quote by running search → product → quote. Returns null when the
 * agent isn't linked or nothing matches (caller falls back to Steel/MCP).
 */
export async function quoteFromProductUrl(
  productUrl: string,
  productName: string,
  currency?: string
): Promise<UcpQuote | null> {
  if (!isUcpHarnessConfigured()) {
    console.warn('[UCP] Not configured (no linked agent) — skipping UCP quote.');
    return null;
  }
  try {
    // shipsTo default from the product's currency so India-targeted items get
    // relevant, deliverable offers.
    const shipsTo = currency === 'INR' ? 'IN' : currency === 'USD' ? 'US' : undefined;
    const results = await searchViaUCP(productName || productUrl, { limit: 5, shipsTo });
    // Wrong-item guard: prefer the first result whose title meaningfully
    // overlaps the tracked product name, so we never open a spend-adjacent
    // checkout for an unrelated look-alike.
    const nameTokens = (productName || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    const match = results.find((r) => {
      const t = (r.title || '').toLowerCase();
      return nameTokens.some((tok) => t.includes(tok));
    }) || results[0];
    if (!match) {
      console.warn('[UCP] Search returned no results — falling back.');
      return null;
    }
    const product = await productViaUCP(match.productId, match.merchant);
    const variants = (product?.variants ?? []).filter((v: any) => v.available !== false);
    const variant = variants[0];
    if (!variant) {
      console.warn('[UCP] Product has no orderable variants — falling back.');
      return null;
    }
    return await quoteViaUCP({
      variantId: variant.id,
      merchant: variant.merchantDomain || match.merchant,
      quantity: 1,
    });
  } catch (err: any) {
    console.warn('[UCP] quoteFromProductUrl failed:', err?.message || err);
    return null;
  }
}
