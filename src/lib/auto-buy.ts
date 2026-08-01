import { pravaClient } from './prava-client';
import { executeMerchantCheckout } from './merchant-executor';
import type { MerchantPaymentCredentials } from './merchant-executor';
import { callMcpTool, listMcpTools, mcpMerchantForUrl, type McpServerConfig } from './mcp-client';
import { quoteFromProductUrl, checkoutViaBrowserHarness, isUcpHarnessConfigured } from './prava-ucp';
import { chatEmailForUser } from './utils';
import type { TrackedProduct } from './types';

export type AutoBuyPhase = 'session_created' | 'awaiting_result' | 'completed' | 'failed' | 'declined' | 'reported' | 'pending_approval';

export interface AutoBuyResult {
  sessionId: string;
  status: AutoBuyPhase;
  detail: string;
  orderReference?: string;
  paymentLink?: string;
  /** Which execution path was used ('mcp' | 'ucp-harness' | 'steel' | 'none'). */
  path?: string;
}

// `chatEmailForUser` moved to ./utils (shared with the chat webhook hot path
// without pulling this heavy module graph into it). Re-exported here so any
// existing importers keep working.
export { chatEmailForUser };
/**
 * Extract the one-time payment credential (network token + dynamic CVV +
 * expiry) from a raw Prava payment-result payload. Credentials are present
 * ONLY while the session status is `awaiting_result`.
 */
export function extractOneTimeCredential(data: any): {
  txnRefId: string;
  credential: MerchantPaymentCredentials;
  amount: string;
} | null {
  const txn = data?.transactions?.[0];
  const item = txn?.line_items?.[0] || data?.line_items?.[0];
  const token = item?.token || item?.network_token;
  const cvv = item?.dynamic_cvv || item?.cvv;
  const expiryMonth = item?.expiry_month || item?.expiryMonth;
  const expiryYear = item?.expiry_year || item?.expiryYear;
  const txnRefId = item?.txn_ref_id || item?.txnRefId || '';

  if (!token || !cvv || !expiryMonth || !expiryYear || !txnRefId) return null;

  return {
    txnRefId,
    credential: {
      pan: String(token),
      cvv: String(cvv),
      expiryMonth: String(expiryMonth).padStart(2, '0'),
      expiryYear: String(expiryYear),
    },
    amount: item?.total_amount || item?.totalAmount || '',
  };
}

/**
 * Phase 1 — create the Prava mandate session for a product whose target
 * price was hit. Does NOT wait for the user's passkey approval. Includes a
 * callback_url so Prava (or the iframe) can redirect back to our
 * execute-buy route the moment the user approves — that's what makes
 * execution fast on the Hobby plan (no long serverless poll needed).
 */
export async function startAutoBuy(product: TrackedProduct, callbackUrl?: string): Promise<AutoBuyResult> {
  const domain = new URL(product.productUrl).hostname.replace('www.', '');
  const session = await pravaClient.createMandateSession({
    userId: product.userId,
    userEmail: chatEmailForUser(product.userId),
    vendorName: product.productName,
    vendorDomain: domain,
    amount: product.currentPrice,
    currency: product.currency,
    description: `Auto-purchase order for ${product.productName} (Target price hit: ${product.currentPrice})`,
    callbackUrl,
  });

  return {
    sessionId: session.sessionId,
    status: 'session_created',
    detail: 'Prava session created; user must approve via passkey',
    paymentLink: session.iframeUrl,
  };
}

/**
 * Try placing the order through the merchant's official MCP server
 * (Zepto / Swiggy) — real merchant, sandbox keys, expected to error until
 * the user supplies an OAuth token. This is the "real merchant" testing path.
 */
async function executeViaMcp(product: TrackedProduct): Promise<{ status: 'approved' | 'declined' | 'failed'; detail: string; orderReference?: string }> {
  const mcp = mcpMerchantForUrl(product.productUrl);
  if (!mcp) return { status: 'failed', detail: 'No MCP merchant matched this product URL' };

  let tools: string[] = [];
  try {
    tools = await listMcpTools(mcp);
  } catch (e: any) {
    return { status: 'failed', detail: `Could not reach ${mcp.name} MCP: ${e?.message || e}` };
  }

  // Filter out read-only/history tools so verb picks don't hit them.
  const pick = (re: RegExp) => tools.find((t) => re.test(t));
  const actionable = tools.filter((t) => !/(history|status|list_|get_|view_|track|search)/i.test(t));

  // 1. Search the catalog for the product by name
  const searchTool = pick(/search|find|lookup|catalog/i);
  if (!searchTool) {
    return { status: 'failed', detail: `${mcp.name} MCP has no search tool (tools: ${tools.slice(0, 8).join(', ')})` };
  }
  const search = await callMcpTool(mcp, searchTool, { query: product.productName, limit: 5 });
  if (!search.ok) {
    return { status: 'failed', detail: `${mcp.name} search failed: ${search.error}` };
  }

  // 2. Add to cart — only from the actionable set so we don't hit read-only
  //    view_cart/get_cart tools.
  const addTool =
    actionable.find((t) => /add|insert/i.test(t)) ||
    actionable.find((t) => /cart/i.test(t));
  if (!addTool) {
    return { status: 'failed', detail: `${mcp.name} MCP has no add-to-cart tool` };
  }
  const added = await callMcpTool(mcp, addTool, { product: product.productName, quantity: 1 });
  if (!added.ok) {
    return { status: 'failed', detail: `${mcp.name} add-to-cart failed: ${added.error}` };
  }

  // 3. Place the order (COD / UPI in sandbox — real card happens via Prava UCP later).
  //    Prefer verbs (place/create/checkout) over nouns (history/status), and
  //    only from the actionable set (no get_order_history-style tools).
  const orderTool =
    actionable.find((t) => /place.*order|create.*order|place_order|checkout/i.test(t)) ||
    actionable.find((t) => /^(?!get_|list_|view_)(order|purchase)/i.test(t)) ||
    actionable.find((t) => /order|checkout|purchase/i.test(t));
  if (!orderTool) {
    return { status: 'failed', detail: `${mcp.name} MCP has no order tool` };
  }
  const order = await callMcpTool(mcp, orderTool, { payment_method: 'COD' });
  if (!order.ok) {
    return { status: 'declined', detail: `${mcp.name} order was not accepted (sandbox expected): ${order.error}` };
  }

  const orderRef = order.text?.match(/(?:order\s*(?:id|number|#)\s*[:#]?\s*[A-Za-z0-9-]{4,})/i)?.[0];
  return {
    status: 'approved',
    detail: `${mcp.name} order placed via MCP`,
    orderReference: orderRef || undefined,
  };
}

/**
 * Execute the purchase with the granted one-time credential.
 * Priority chain:
 *   1. MCP merchant (Zepto/Swiggy official MCP — real merchant sandbox test)
 *   2. Prava UCP quote → Browser Harness (documented Prava checkout)
 *   3. Steel merchant executor (selector-based, best-effort fallback)
 *
 * The credential ALWAYS comes from Prava's hosted vaulting page (the secure
 * link the user approves) — never from chat. If no credential is granted,
 * we fail closed rather than accepting a raw card.
 */
async function executePayment(
  product: TrackedProduct,
  credential: MerchantPaymentCredentials | null
): Promise<{ status: 'approved' | 'declined' | 'failed' | 'blocked'; detail: string; orderReference?: string; path?: string }> {
  // Path 1 — merchant MCP server (official integration). MCP is authoritative
  // for its OWN merchants (Zepto/Swiggy); for other URLs we fall through.
  const mcpMatched = mcpMerchantForUrl(product.productUrl) !== null;
  if (mcpMatched) {
    const mcpPath = await executeViaMcp(product);
    return { ...mcpPath, path: 'mcp' };
  }

  // Path 2 — Prava UCP quote → Browser Harness (the wallet shop API the CLI
  // uses: search → product → quote → checkout). Needs the granted credential.
  if (isUcpHarnessConfigured() && credential) {
    try {
      const quote = await quoteFromProductUrl(product.productUrl, product.productName, product.currency);
      if (quote) {
        // Amount-binding: the docs say credentials are "amount-scoped" and the
        // charged total is bound to the quote. Our session was minted for the
        // SCRAPED price, while the UCP quote adds shipping + tax — the docs'
        // own example is $17 item → $22.45 total (+32%). So the guard uses a
        // generous, env-tunable tolerance (PRAVA_AMOUNT_TOLERANCE, default
        // 0.35) and fails closed only on true anomalies. The fully correct
        // architecture (mint the session FOR the quoted total) is tracked as
        // a follow-up.
        const quoted = quote.finalPrice?.amount;
        const expected = product.currentPrice;
        if (quoted != null && expected > 0) {
          // Guard against a malformed env value (Number() → NaN would make
          // `drift > tolerance` always false, silently disabling the guard).
          const rawTolerance = Number(process.env.PRAVA_AMOUNT_TOLERANCE);
          const tolerance = Number.isFinite(rawTolerance) && rawTolerance > 0 ? rawTolerance : 0.35;
          const drift = Math.abs(quoted - expected) / expected;
          if (drift > tolerance) {
            return {
              status: 'failed',
              detail: `UCP quoted total ${quote.finalPrice.currency} ${quoted.toFixed(2)} diverges ${(drift * 100).toFixed(0)}% from session amount ${expected.toFixed(2)} — refusing to charge mismatched amount. Remedy: mint a new Prava session for the quoted total, then re-checkout.`,
              path: 'ucp-harness',
            };
          }
        }
        const harness = await checkoutViaBrowserHarness(quote, {
          token: credential.pan,
          cryptogram: credential.cvv, // CLI maps Prava's dynamic_cvv → cryptogram
          expiryMonth: credential.expiryMonth,
          expiryYear: credential.expiryYear,
        });
        if (harness.status === 'completed' || harness.status === 'reconciled') {
          return {
            status: 'approved',
            detail: `Prava Browser Harness: ${harness.detail}`,
            orderReference: harness.orderReference,
            path: 'ucp-harness',
          };
        }
        return { status: 'declined', detail: harness.detail, path: 'ucp-harness' };
      }
      // quote returned null — fall through to Steel
    } catch (e: any) {
      return { status: 'failed', detail: `UCP quote threw: ${e?.message || e}`, path: 'ucp-harness' };
    }
  }

  // Path 3 — Steel merchant executor (needs a card credential)
  if (credential) {
    const outcome = await executeMerchantCheckout(product.productUrl, credential, {
      amount: product.currentPrice,
      currency: product.currency,
    });
    return { ...outcome, path: 'steel' };
  }

  return { status: 'failed', detail: 'No executable payment path (no credential, no MCP, UCP harness not configured)', path: 'none' };
}

/**
 * Phase 2 — poll an existing session until the user approves (credentials
 * granted at `awaiting_result`), execute the real merchant checkout with the
 * one-time credential, and report APPROVED/DECLINED back to Prava.
 *
 * Fail-safe: we only report APPROVED after a positive merchant success
 * signal. Unknown/blocked outcomes are reported DECLINED (or left for retry)
 * rather than claiming success.
 */
export async function executeAutoBuy(
  product: TrackedProduct,
  sessionId: string,
  opts: {
    pollAttempts?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<AutoBuyResult> {
  // Hobby plan: serverless functions cap at 60s. Default polling budget is
  // ~30s (12 × 2.5s) so there's room left for the merchant call.
  const { pollAttempts = 12, pollIntervalMs = 2500 } = opts;

  let lastStatus = 'pending';
  for (let i = 0; i < pollAttempts; i++) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const res = await pravaClient.pollPaymentResult(sessionId);
    lastStatus = res.status;

    if (res.status === 'completed' || res.status === 'failed') {
      return { sessionId, status: res.status === 'completed' ? 'completed' : 'failed', detail: `Prava session ${res.status}` };
    }

    if (res.status === 'awaiting_result') {
      // Credentials granted — go buy at the merchant
      const raw = await pravaClient.fetchRawPaymentResultForExecutor(sessionId);
      const cred = extractOneTimeCredential(raw);

      // Hobby 60s ceiling: bound the merchant execution so poll + payment
      // never exceed the serverless limit. The 30s poll worst case only
      // happens on the no-approval path (which never reaches payment), so a
      // 50s payment budget fits comfortably (callback path: ~5s poll + 50s).
      // UCP discovery chain worst case (8+8+30s) and Steel checkout (~30s)
      // both fit. On timeout we return a failed outcome — the cron/callback
      // can retry later.
      const PAYMENT_BUDGET_MS = 50000;
      const outcome = await Promise.race([
        executePayment(product, cred?.credential ?? null).catch((err): { status: 'failed'; detail: string; path: 'none' } => ({
          status: 'failed',
          detail: `Merchant execution threw: ${err instanceof Error ? err.message : String(err)}`,
          path: 'none',
        })),
        new Promise<{ status: 'failed'; detail: string; path: 'none' }>((resolve) =>
          setTimeout(() => resolve({ status: 'failed', detail: 'Merchant execution exceeded 50s budget', path: 'none' }), PAYMENT_BUDGET_MS)
        ),
      ]);

      if (outcome.status === 'approved') {
        if (cred) {
          await pravaClient.reportTransactionStatus(sessionId, {
            txnRefId: cred.txnRefId,
            txnStatus: 'APPROVED',
            amountPaid: cred.amount || product.currentPrice.toFixed(2),
            authorizationCode: outcome.orderReference || 'AUTHOK',
            responseCode: '00',
          });
        }
        return {
          sessionId,
          status: 'reported',
          detail: `Merchant approved (${outcome.detail})`,
          orderReference: outcome.orderReference,
          path: outcome.path,
        };
      }

      // Decline / blocked / failed at the merchant — report DECLINED (only if
      // we actually had a Prava credential to report against).
      if (cred) {
        await pravaClient.reportTransactionStatus(sessionId, {
          txnRefId: cred.txnRefId,
          txnStatus: 'DECLINED',
          amountPaid: cred.amount || product.currentPrice.toFixed(2),
          responseCode: '05',
        }).catch((e) => console.warn('[AutoBuy] report DECLINED failed:', e));
      }

      return {
        sessionId,
        status: outcome.status === 'declined' ? 'declined' : 'failed',
        detail: outcome.detail,
        path: outcome.path,
      };
    }
  }

  return { sessionId, status: 'pending_approval', detail: `User has not approved yet (last status: ${lastStatus})` };
}

/**
 * Convenience: create + execute in one call (used by the manual execute-buy
 * API route). If `executePayment` is false, only creates the session.
 */
export async function runAutoBuy(
  product: TrackedProduct,
  opts: { executePayment?: boolean; callbackUrl?: string } = {}
): Promise<AutoBuyResult> {
  const started = await startAutoBuy(product, opts.callbackUrl);
  if (!opts.executePayment) return started;
  return executeAutoBuy(product, started.sessionId);
}
