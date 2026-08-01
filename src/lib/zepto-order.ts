/**
 * Quick-commerce ordering via the Zepto MCP server.
 *
 * Flow for a chat message like "order me amul milk and bread" (routed here by
 * the Purchase Director when the category is grocery):
 *  1. Parse items + quantities (LLM first, regex fallback — shared with food).
 *  2. Ensure the Zepto account is registered (get_user_details →
 *     update_user_name with the user's name, asked via chat when missing).
 *  3. list_saved_addresses → pick the first saved delivery address →
 *     select_saved_address.
 *  4. search_products for every item → best match → product variant IDs.
 *  5. update_cart with the chosen items.
 *  6. get_payment_methods → ask **cash, upi, or card?** (or use a method the
 *     user already mentioned).
 *
 * Payment method branch (mirrors the Swiggy food engine):
 *   * cash → create_order (COD)
 *   * upi  → create_upi_reserve_pay_order (NPCI/Razorpay UPI Reserve Pay)
 *   * card → Prava mandate session + 🔒 secure payment link; the user approves
 *            there (card never touches chat), then replies "done" and we
 *            finalize via create_online_payment_order.
 *
 * Sandbox reality: real orders on the user's Zepto account. A merchant error
 * at any step is expected until production credentials/addresses are fully
 * set up — failures are surfaced verbatim so the operator sees exactly which
 * step the sandbox blocks.
 */
import { callMcpTool, ZEPTO_MCP, type McpServerConfig } from './mcp-client';
import { pravaClient } from './prava-client';
import { parseFoodOrderItems, normalizeFoodItems, pickBestMatch, detectPaymentMethod, ANSWER_RE, FINALIZE_RE, type FoodOrderContext, type FoodOrderItem } from './food-order';
import { chatEmailForUser } from './utils';

const ZEPTO: McpServerConfig = { ...ZEPTO_MCP, timeoutMs: 8000 };

export interface ZeptoCartLine {
  productVariantId: string;
  storeProductId?: string;
  quantity: number;
  name: string;
  /** Short product label (raw title) for display. */
  label?: string;
  /** Selling price in paisa (Zepto's cart contract). */
  price?: number;
  mrp?: number;
  packSize?: string;
}

interface ParsedProduct {
  name: string;
  priceInr: number;
  packSize?: string;
  productVariantId: string;
  storeProductId?: string;
}

interface ZeptoPendingOrder {
  ctx: FoodOrderContext;
  items: FoodOrderItem[];
  addressId: string;
  addressLabel: string;
  cartLines: ZeptoCartLine[];
  method: 'cash' | 'card' | 'upi' | null;
  /** Set while we're waiting for the user to give their name for registration. */
  awaitingName: boolean;
  pravaSessionId?: string;
  /** Prava iframe URL for the user to approve the card payment (dashboard link). */
  paymentLink?: string;
  createdAt: number;
}

// Per-chat pending orders (in-memory — lost on serverless cold start, which is
// acceptable for the sandbox ask → answer round trip).
const pendingOrders = new Map<string, ZeptoPendingOrder>();
const PENDING_TTL_MS = 20 * 60 * 1000;

function getPendingOrder(chatId: string): ZeptoPendingOrder | null {
  const p = pendingOrders.get(chatId);
  if (!p) return null;
  if (Date.now() - p.createdAt > PENDING_TTL_MS) {
    pendingOrders.delete(chatId);
    return null;
  }
  return p;
}

/** Is the Zepto account registered? (text-based check on get_user_details) */
async function isRegistered(): Promise<boolean> {
  const res = await callMcpTool(ZEPTO, 'get_user_details', {});
  return res.ok && /Registered:\s*Yes/i.test(res.text || '');
}

/** Register the Zepto account with the user's full name. */
async function registerUser(fullName: string): Promise<{ ok: boolean; text: string }> {
  const res = await callMcpTool(ZEPTO, 'update_user_name', { fullName: fullName.trim().slice(0, 80) });
  if (!res.ok) return { ok: false, text: `❌ Zepto registration failed: ${res.error}` };
  return { ok: true, text: res.text || '' };
}

/** Return the first saved address (id + label) or null. */
async function pickZeptoAddress(): Promise<{ id: string; label: string } | null> {
  const res = await callMcpTool(ZEPTO, 'list_saved_addresses', {});
  if (!res.ok) return null;
  for (const line of (res.text || '').split('\n')) {
    const m = line.match(/\(ID:\s*([A-Za-z0-9]+)\)/);
    if (m && /^\s*\d+\./.test(line)) {
      return { id: m[1], label: line.replace(/^\s*\d+\.\s*/, '').slice(0, 80) };
    }
  }
  return null;
}

/** Set the store context for the chosen address (required before cart ops). */
async function selectAddress(addressId: string): Promise<boolean> {
  const res = await callMcpTool(ZEPTO, 'select_saved_address', { addressId });
  return res.ok;
}

/**
 * Parse a search_products response into structured products. The Zepto MCP
 * returns a numbered, human-readable list — we accept a few known shapes:
 *
 *   "1. Amul Taaza Milk 500ml — ₹27 | 500ml | (ID: <uuid>)"
 *   "1. Amul Taaza Milk — ₹27 | (pvid: <uuid>, spid: <id>)"
 */
function parseProducts(text: string): ParsedProduct[] {
  const out: ParsedProduct[] = [];
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\s*\d+\.\s+(.+?)\s*[—-]\s*₹([\d,]+)(?:\s*\|\s*([^|]*?))?(?:\s*\|\s*(.+))?$/i);
    if (!m) continue;
    const rest = (m[4] || '') + ' ' + line;
    const pvidMatch = rest.match(/(?:ID|pvid|productVariantId)[:\s]+([A-Za-z0-9-]{8,})/i);
    const spidMatch = rest.match(/(?:spid|storeProductId)[:\s]+([A-Za-z0-9-]{4,})/i);
    if (!pvidMatch) continue;
    out.push({
      name: m[1].trim().slice(0, 80),
      priceInr: parseFloat(m[2].replace(/,/g, '')),
      packSize: (m[3] || '').trim() || undefined,
      productVariantId: pvidMatch[1],
      storeProductId: spidMatch?.[1],
    });
  }
  return out;
}

function cartLinesText(cartLines: ZeptoCartLine[]): string {
  return cartLines
    .map((c) => `  • ${c.name}${c.packSize ? ` (${c.packSize})` : ''}${c.price ? ` ₹${(c.price / 100).toFixed(2)}` : ''} ×${c.quantity}`)
    .join('\n');
}

/** Estimated order total (₹) from cart prices (stored in paisa). */
function orderTotal(cartLines: ZeptoCartLine[]): number {
  return cartLines.reduce((sum, c) => sum + (c.price || 0) * c.quantity, 0) / 100;
}

/** Ask the user to pick a payment method (order parked in pending store). */
function askPaymentMethodReply(p: ZeptoPendingOrder): string {
  return (
    `🛒 *Ready to order from Zepto* — quick commerce.\n\n` +
    `📦 *Items*:\n${cartLinesText(p.cartLines)}\n\n` +
    `📍 *Deliver to*: ${p.addressLabel}\n` +
    `💳 *How would you like to pay?*\n` +
    `  • Reply **cash** → Cash on Delivery\n` +
    `  • Reply **upi** → pay via UPI (Reserve Pay)\n` +
    `  • Reply **card** → 🔒 secure Prava payment link\n\n` +
    `_Reply **cancel** to drop this order._`
  );
}

/** Place a Zepto order after the user picked a method (COD / UPI / online). */
async function placeZeptoOrder(
  p: ZeptoPendingOrder,
  kind: 'cash' | 'upi' | 'card',
  paymentLabel: string
): Promise<{ ok: boolean; text: string }> {
  // Safety gate: don't place REAL-money orders unless explicitly enabled.
  if (process.env.ZEPTO_AUTO_ORDER !== '1') {
    return {
      ok: false,
      text:
        `🛒 *Ready to order from Zepto*\n\n` +
        `📦 *Items*:\n${cartLinesText(p.cartLines)}\n\n` +
        `💵 *Payment*: ${paymentLabel}\n\n` +
        `⚠️ Auto-ordering is currently *off* (set \`ZEPTO_AUTO_ORDER=1\` to enable live orders).`,
    };
  }

  // Verify payment methods are actually available at the cart — and that the
  // CHOSEN method is offered, so we fail with a friendly message instead of
  // driving a UPI order Zepto won't accept.
  const payRes = await callMcpTool(ZEPTO, 'get_payment_methods', {});
  if (!payRes.ok) {
    return { ok: false, text: `💳 Couldn't fetch Zepto payment methods: ${payRes.error}\n\nItems are in your Zepto cart — finish manually if you'd like.` };
  }
  const payText = payRes.text || '';
  const wanted = kind === 'upi' ? /upi/i : kind === 'card' ? /online|card|upi/i : /cod|cash/i;
  if (!wanted.test(payText)) {
    return {
      ok: false,
      text: `💳 ${kind === 'upi' ? 'UPI' : kind === 'card' ? 'Online/card' : 'Cash-on-delivery'} doesn't look available at Zepto for this cart.\n\nAvailable: ${payText.slice(0, 300)}\n\nItems are in your Zepto cart — pick another method or finish manually.`,
    };
  }

  const commonArgs = {
    confirmOrder: true,
    userAddressId: p.addressId,
    riderTip: 0,
    useZeptoCash: false,
  };

  // COD / UPI / online each have their own order tool; the preview step
  // (confirmOrder:false) is skipped since the user already confirmed the cart
  // by choosing a payment method here.
  const tool = kind === 'upi' ? 'create_upi_reserve_pay_order' : kind === 'card' ? 'create_online_payment_order' : 'create_order';
  const res = await callMcpTool(ZEPTO, tool, commonArgs);

  const orderRef = res.ok
    ? (res.text || '').match(/(?:order\s*(?:id|number|#)\s*[:#]?\s*[A-Za-z0-9-]{4,})/i)?.[0]
    : undefined;

  if (res.ok) {
    return {
      ok: true,
      text:
        `✅ *Order placed via Zepto!*\n\n` +
        `📦 *Items*:\n${cartLinesText(p.cartLines)}\n` +
        `📍 *Deliver to*: ${p.addressLabel}\n` +
        `💵 *Payment*: ${paymentLabel}\n` +
        (orderRef ? `🧾 ${orderRef}\n` : '') +
        `I'll track the order and keep you posted.`,
    };
  }

  return {
    ok: false,
    text:
      `⚠️ *Order attempt did not complete* (sandbox expected).\n\n` +
      `📦 *Items*:\n${cartLinesText(p.cartLines)}\n` +
      `📍 *Deliver to*: ${p.addressLabel}\n\n` +
      `❌ *At checkout*: ${res.error || 'Unknown merchant error'}\n\n` +
      `I've left the items in your Zepto cart so you can finish manually if you'd like.`,
  };
}

/** Card path: create a Prava mandate session and return the secure link reply. */
async function startPravaForZepto(p: ZeptoPendingOrder): Promise<string> {
  const total = orderTotal(p.cartLines);
  const safeTotal = total > 0 ? total : 1; // never mint a zero-amount session
  try {
    const session = await pravaClient.createMandateSession({
      userId: p.ctx.userId,
      userEmail: chatEmailForUser(p.ctx.userId),
      vendorName: 'Zepto',
      vendorDomain: 'zepto.co.in',
      amount: safeTotal,
      currency: 'INR',
      description: `Zepto order: ${p.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}`,
    });

    p.method = 'card';
    p.pravaSessionId = session.sessionId;
    p.paymentLink = session.iframeUrl;
    pendingOrders.set(p.ctx.chatId, p);

    const totalNote = total > 0 ? `💰 *Total*: ₹${total.toLocaleString('en-IN')}\n` : '';
    return (
      `💳 *Pay by card via Prava — secure link*\n\n` +
      `🛒 *Store*: Zepto\n` +
      `📦 *Items*:\n${cartLinesText(p.cartLines)}\n` +
      `${totalNote}\n` +
      `🔒 Approve the payment here (your card stays in Prava's vault — never in chat):\n${session.iframeUrl}\n\n` +
      `Once you've approved, reply **done** and I'll place your order.`
    );
  } catch (err: any) {
    return `❌ Couldn't start the Prava payment: ${err?.message || err}\n\nYou can still reply **cash** or **upi** instead.`;
  }
}

/**
 * Handle a follow-up reply for a pending Zepto order:
 *  - "<name>" (awaitingName)  → register the account, then re-run resolution
 *  - "cash" / "cod"            → place via Cash-on-Delivery
 *  - "upi"                     → place via UPI Reserve Pay
 *  - "card" / "upi"            → create Prava session + secure link (then "done")
 *  - "done" (after card)       → poll Prava result, then finalize the order
 *  - "cancel"                  → drop the pending order
 * Returns null when the message is NOT an answer to a pending Zepto order.
 */
export async function resolvePendingZeptoOrder(chatId: string, text: string): Promise<string | null> {
  const pending = getPendingOrder(chatId);
  if (!pending) return null;

  const t = text.trim().toLowerCase();

  if (/^\s*(?:cancel|never mind|forget|drop it|nevermind)[.!]*\s*$/i.test(t)) {
    pendingOrders.delete(chatId);
    return `🚫 Zepto order cancelled.`;
  }

  // Registration name collection — any non-answer word is treated as the name.
  if (pending.awaitingName) {
    if (ANSWER_RE.test(t)) {
      return `🤔 I still need your full name to register you on Zepto. Reply with your name, e.g. \`Ananya Sharma\`.`;
    }
    const reg = await registerUser(text);
    if (!reg.ok) return reg.text;
    // Registered — re-run the resolution with the stored order text.
    pending.awaitingName = false;
    pendingOrders.set(chatId, pending);
    const resolved = await resolveZeptoOrderFromItems(pending.ctx, pending.items);
    if (typeof resolved === 'string') {
      pendingOrders.delete(chatId);
      return resolved;
    }
    pendingOrders.set(chatId, resolved);
    return askPaymentMethodReply(resolved);
  }

  if (pending.method === 'card') {
    if (FINALIZE_RE.test(t)) {
      const sessionId = pending.pravaSessionId!;
      let status = 'pending';
      for (let i = 0; i < 6; i++) {
        try {
          const res = await pravaClient.pollPaymentResult(sessionId);
          status = res.status;
          if (status === 'awaiting_result' || status === 'completed' || status === 'failed') break;
        } catch { /* transient poll error — retry */ }
        await new Promise((r) => setTimeout(r, 2000));
      }

      if (status === 'failed') {
        pendingOrders.delete(chatId);
        return `❌ *Prava payment failed.*\n\nYour order was not placed. Reply with the order again, or choose **cash**/**upi** instead.`;
      }
      if (status !== 'awaiting_result' && status !== 'completed') {
        return `⏳ I haven't seen your Prava approval yet. Open the secure link and approve it, then reply **done** again.`;
      }

      const placed = await placeZeptoOrder(pending, 'card', 'Prava card (approved)');

      // Report transaction outcome to Prava so the session is properly closed
      // and the one-time credential is consumed (mirrors auto-buy.ts behavior).
      try {
        const raw = await pravaClient.fetchRawPaymentResultForExecutor(sessionId);
        const txn = raw?.transactions?.[0];
        const item = txn?.line_items?.[0] || raw?.line_items?.[0];
        const txnRefId = item?.txn_ref_id || item?.txnRefId || '';
        if (txnRefId) {
          await pravaClient.reportTransactionStatus(sessionId, {
            txnRefId,
            txnStatus: placed.ok ? 'APPROVED' : 'DECLINED',
            amountPaid: item?.total_amount || item?.totalAmount || String(orderTotal(pending.cartLines)),
            authorizationCode: placed.ok ? 'CHAT_ORDER_OK' : undefined,
            responseCode: placed.ok ? '00' : '05',
          });
        }
      } catch (reportErr) {
        console.warn('[ZeptoOrder] Failed to report Prava transaction status:', reportErr);
      }

      if (placed.ok) pendingOrders.delete(chatId);
      return `✅ *Prava payment approved!* Placing your Zepto order now…\n\n${placed.text}`;
    }

    // Allow switching away from card: if the user says "cash" or "upi" while
    // in the card flow, reset the method and process as a fresh payment answer.
    const switchMethod = detectPaymentMethod(t);
    if (switchMethod === 'cash') {
      pending.method = null;
      const reply = await placeZeptoOrder(pending, 'cash', 'Cash (COD)');
      if (reply.ok) pendingOrders.delete(chatId);
      return reply.text;
    }
    if (switchMethod === 'upi') {
      pending.method = null;
      const reply = await placeZeptoOrder(pending, 'upi', 'UPI');
      if (reply.ok) pendingOrders.delete(chatId);
      return reply.text;
    }
    return null;
  }

  // No method chosen yet — interpret the answer.
  const method = detectPaymentMethod(t);
  if (method === 'cash') {
    const reply = await placeZeptoOrder(pending, 'cash', 'Cash (COD)');
    if (reply.ok) pendingOrders.delete(chatId);
    return reply.text;
  }
  if (method === 'upi') {
    const reply = await placeZeptoOrder(pending, 'upi', 'UPI');
    if (reply.ok) pendingOrders.delete(chatId);
    return reply.text;
  }
  if (method === 'card') {
    return startPravaForZepto(pending);
  }
  return null;
}

/** Resolve items → address → product matches → cart lines (no payment yet). */
async function resolveZeptoOrderFromItems(
  ctx: FoodOrderContext,
  items: FoodOrderItem[]
): Promise<ZeptoPendingOrder | string> {
  if (!items.length) {
    return '🛒 I couldn\'t figure out what to order. Try: `order me amul milk and 2 bread`';
  }

  const address = await pickZeptoAddress();
  if (!address) {
    return '📍 No saved delivery address found. Add one in the Zepto app, then try again.';
  }
  if (!(await selectAddress(address.id))) {
    return `📍 Couldn't select your saved address on Zepto (${address.label}). Try again in a moment.`;
  }

  const cartLines: ZeptoCartLine[] = [];
  const missing: string[] = [];

  for (const it of items) {
    const search = await callMcpTool(ZEPTO, 'search_products', { query: it.name, pageNumber: 0 });
    const matches = search.ok ? parseProducts(search.text || '') : [];
    // Most-relevant name match wins — "Amul Taaza Milk 500ml" beats a generic
    // "Milk" hit, and a typo'd query like "amul mlik" still resolves.
    const match = pickBestMatch(matches, it.name, (m) => m.name);
    if (match) {
      cartLines.push({
        productVariantId: match.productVariantId,
        storeProductId: match.storeProductId,
        quantity: it.quantity,
        name: match.name,
        label: match.name,
        price: Math.round(match.priceInr * 100), // ₹ → paisa (Zepto's cart contract)
        mrp: Math.round(match.priceInr * 100),
        packSize: match.packSize,
      });
    } else {
      missing.push(it.name);
    }
  }

  if (!cartLines.length) {
    return `😕 None of those items were found on Zepto: ${items.map((i) => i.name).join(', ')}. Try a different order.`;
  }

  // Sync the cart with the matched items (Zepto cart persists per session).
  const cartRes = await callMcpTool(ZEPTO, 'update_cart', {
    cartItems: cartLines.map((c) => ({
      productVariantId: c.productVariantId,
      // Only include storeProductId when defined — undefined values may cause
      // the Zepto MCP to reject the cart update payload.
      ...(c.storeProductId ? { storeProductId: c.storeProductId } : {}),
      quantity: c.quantity,
      name: c.name,
      label: c.label,
      price: c.price,
      mrp: c.mrp,
      packSize: c.packSize,
    })),
  });
  if (!cartRes.ok) {
    return `🛒 Cart update on Zepto failed: ${cartRes.error}\n\nTry again in a moment, or order manually in the Zepto app.`;
  }

  return {
    ctx,
    items,
    addressId: address.id,
    addressLabel: address.label,
    cartLines,
    method: null,
    awaitingName: false,
    createdAt: Date.now(),
  };
}

/**
 * Order groceries from chat text. Returns the chat reply (Markdown).
 * Routes here from the Purchase Director when category is "grocery".
 * `itemsOverride` supplies items already parsed + typo-corrected by OpenAI;
 * when absent the text is parsed here and spelling-normalized.
 */
export async function orderZeptoFromChat(
  text: string,
  ctx: FoodOrderContext,
  itemsOverride?: FoodOrderItem[]
): Promise<string> {
  let items = itemsOverride && itemsOverride.length ? itemsOverride : await parseFoodOrderItems(text);
  if (!items || !items.length) {
    return '🛒 I couldn\'t figure out what to order. Try: `order me amul milk and 2 bread`';
  }
  // Fix typos ("amul mlik" → "amul milk") when the items came from the raw
  // regex parse so the product search actually finds them.
  if (!itemsOverride) {
    const corrected = await normalizeFoodItems(items);
    if (corrected) items = corrected;
  }

  // Registration first — Zepto won't serve any tool until the account is set up.
  if (!(await isRegistered())) {
    pendingOrders.set(ctx.chatId, {
      ctx,
      items,
      addressId: '',
      addressLabel: '',
      cartLines: [],
      method: null,
      awaitingName: true,
      createdAt: Date.now(),
    });
    return `🛒 Zepto needs your full name to register you (one-time).\n\nReply with your name, e.g. \`Ananya Sharma\`, and I'll set up your account and continue the order.`;
  }

  const resolved = await resolveZeptoOrderFromItems(ctx, items);
  if (typeof resolved === 'string') return resolved;

  const method = detectPaymentMethod(text);
  if (method === 'cash') {
    return (await placeZeptoOrder(resolved, 'cash', 'Cash (COD)')).text;
  }
  if (method === 'upi') {
    return (await placeZeptoOrder(resolved, 'upi', 'UPI')).text;
  }
  if (method === 'card') {
    return startPravaForZepto(resolved);
  }

  // Unspecified → park the order and ask.
  pendingOrders.set(ctx.chatId, resolved);
  return askPaymentMethodReply(resolved);
}

// ─── Dashboard console snapshot ──────────────────────────────────────────────

export interface PendingZeptoOrderSummary {
  engine: 'zepto';
  chatId: string;
  userId: string;
  channel: string;
  items: FoodOrderItem[];
  addressLabel: string;
  total: number;
  method: 'cash' | 'card' | 'upi' | null;
  awaitingName: boolean;
  pravaSessionId?: string;
  paymentLink?: string;
  createdAt: number;
  ageSeconds: number;
  /** Human status for the console. */
  status: 'awaiting_registration_name' | 'awaiting_payment_method' | 'awaiting_prava_approval' | 'placing';
}

/** Snapshot live pending Zepto orders (serializable, oldest first). */
export function listPendingZeptoOrders(): PendingZeptoOrderSummary[] {
  const out: PendingZeptoOrderSummary[] = [];
  const now = Date.now();
  for (const [chatId, p] of pendingOrders) {
    if (now - p.createdAt > PENDING_TTL_MS) {
      pendingOrders.delete(chatId); // evict stale entries while listing
      continue;
    }
    out.push({
      engine: 'zepto',
      chatId,
      userId: p.ctx.userId,
      channel: p.ctx.channel,
      items: p.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      addressLabel: p.addressLabel || '—',
      total: orderTotal(p.cartLines),
      method: p.method,
      awaitingName: p.awaitingName,
      pravaSessionId: p.pravaSessionId,
      paymentLink: p.paymentLink,
      createdAt: p.createdAt,
      ageSeconds: Math.floor((now - p.createdAt) / 1000),
      status: p.awaitingName
        ? 'awaiting_registration_name'
        : p.method === 'card'
          ? 'awaiting_prava_approval'
          : p.method
            ? 'placing'
            : 'awaiting_payment_method',
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

