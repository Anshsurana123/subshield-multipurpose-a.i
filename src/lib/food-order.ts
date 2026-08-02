/**
 * Food ordering via the Swiggy Food MCP server.
 *
 * Flow for a chat message like "order me paneer tikka and 2 butter naan":
 *  1. Parse items + quantities (LLM first, regex fallback).
 *  2. get_addresses → pick the user's saved delivery address.
 *  3. search_restaurants(query = main item) → probe top results → pick the
 *     MOST-RELEVANT restaurant that actually serves the main dish
 *     (relevance beats rating).
 *  4. search_menu (scoped to that restaurant) for every item → item IDs.
 *  5. update_food_cart with the chosen items.
 *  6. get_payment_options → place_food_order.
 *
 * Payment method branch:
 *  - If the message specifies a method ("cash", "cod", "upi", "pay by card"...)
 *    we use it directly.
 *  - Otherwise we ask **cash, upi, or card?** and park the resolved order in a
 *    per-chat pending store. A follow-up reply resolves it:
 *      * cash → Swiggy Cash/COD chain
 *      * upi  → Swiggy UPI chain (place_food_order paymentMethod: UPI)
 *      * card → Prava mandate session + 🔒 secure payment link; the user
 *                approves there (card never touches chat), then replies
 *                "done" and we finalize the Swiggy order.
 *
 * Sandbox reality: real orders on the user's Swiggy account. A merchant
 * error at any step is expected until production credentials/addresses are
 * fully set up — failures are surfaced verbatim so the operator sees exactly
 * which step the sandbox blocks.
 */
import OpenAI from 'openai';
import { callMcpTool, SWIGGY_FOOD_MCP, type McpServerConfig } from './mcp-client';
import { pravaClient } from './prava-client';
import { chatEmailForUser } from './utils';
import type { ChatChannel } from './types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

export interface FoodOrderItem {
  name: string;
  quantity: number;
}

export interface FoodOrderContext {
  userId: string;
  channel: ChatChannel;
  chatId: string;
}

interface ParsedRestaurant {
  name: string;
  rating: number;
  minutes: number;
  id: string;
}

interface ParsedMenuItem {
  name: string;
  price: number;
  /** Present only in unscoped search responses; scoped responses omit it. */
  restaurantId?: string;
  id: string;
}

interface CartLine {
  itemId: string;
  quantity: number;
  itemName: string;
  price?: number;
}

/** Everything needed to place a pending food order once payment is chosen. */
interface PendingOrder {
  ctx: FoodOrderContext;
  items: FoodOrderItem[];
  address: { id: string; label: string };
  restaurant: ParsedRestaurant;
  queriedFor: string;
  cartLines: CartLine[];
  missing: string[];
  /** null until the user picks a method; 'card' once a Prava session is live. */
  method: 'cash' | 'card' | 'upi' | null;
  pravaSessionId?: string;
  /** Prava iframe URL for the user to approve the card payment (dashboard link). */
  paymentLink?: string;
  createdAt: number;
}

import { saveDurablePendingOrder, getDurablePendingOrder, deleteDurablePendingOrder } from './persistent-orders';

// Per-chat pending orders (in-memory cache + Supabase persistent fallback)
const pendingOrders = new Map<string, PendingOrder>();
const PENDING_TTL_MS = 30 * 60 * 1000;

/** Fetch a chat's pending order from memory or Supabase, evicting if TTL lapsed. */
async function getPendingOrder(chatId: string): Promise<PendingOrder | null> {
  const p = pendingOrders.get(chatId);
  if (p) {
    if (Date.now() - p.createdAt <= PENDING_TTL_MS) {
      return p;
    }
    pendingOrders.delete(chatId);
    await deleteDurablePendingOrder(chatId, 'food');
    return null;
  }
  const durable = await getDurablePendingOrder<PendingOrder>(chatId, 'food');
  if (durable) {
    pendingOrders.set(chatId, durable);
    return durable;
  }
  return null;
}

async function savePendingOrder(chatId: string, order: PendingOrder): Promise<void> {
  pendingOrders.set(chatId, order);
  await saveDurablePendingOrder(chatId, 'food', order);
}

async function removePendingOrder(chatId: string): Promise<void> {
  pendingOrders.delete(chatId);
  await deleteDurablePendingOrder(chatId, 'food');
}

// Chain budget: up to ~7 sequential calls must fit the 60s serverless
// ceiling, so each call gets a tight 8s timeout (real responses are ~1-3s).
const FOOD_MCP: McpServerConfig = { ...SWIGGY_FOOD_MCP, timeoutMs: 8000 };

/** Quick gate — does this message look like a food order (no product URL)? */
export function looksLikeFoodOrder(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return false; // has a product URL → price-tracker territory
  return /^\s*(?:please\s+)?(?:order|get|bring|i want|can you order|order me|deliver|send me)\b/i.test(t);
}

/**
 * Detect an explicit payment method in the order text.
 * Returns 'cash' | 'card' | 'upi' | null (null = unspecified → must ask).
 */
export function detectPaymentMethod(text: string): 'cash' | 'card' | 'upi' | null {
  const t = text.toLowerCase();
  const cash = /\b(cash|cod|pay on delivery|cash on delivery|on delivery)\b/.test(t);
  const upi = /\b(upi|gpay|google pay|phonepe|paytm|upi payment|pay by upi|via upi)\b/.test(t);
  const card = /\b(card|credit|debit|prava|pay by card|via card|card payment|online)\b/.test(t);
  if (cash && !card && !upi) return 'cash';
  if (upi && !card) return 'upi';
  if (card && !cash && !upi) return 'card';
  return null; // both or neither → ask
}

/** Payment-phrasing that must never become a menu item ("pay by card"). */
const PAYMENT_PHRASE_RE =
  /\b(?:pay(?:\s+(?:by|with|via))?\s+(?:card|cash|upi)|(?:by|via|with)\s+(?:card|cash|upi)|card\s+payment|(?:cash|pay)\s+on\s+delivery|on\s+delivery|payment\s+method)\b/i;

/** Regex fallback: "paneer tikka and 2 butter naan" → [{paneer tikka,1},{butter naan,2}] */
function parseItemsRegex(text: string): FoodOrderItem[] {
  const body = text
    .replace(/^\s*(?:please\s+)?(?:order|get|bring|i want|can you order|order me|deliver|send me)\s+(?:me\s+)?/i, '')
    .trim();
  if (!body) return [];
  // Split on "and", "with", "&", or commas — "with" is a common variant
  // ("paneer tikka with 2 butter naan") that would otherwise mis-parse.
  const parts = body.split(/\s+(?:and|with|&)\s+|\s*,\s*/i).map((p) => p.trim()).filter(Boolean);
  const items: FoodOrderItem[] = [];
  for (const part of parts) {
    const m = part.match(/^(?:(\d+)\s+)?(.+?)\s*$/i);
    if (!m || !m[2]) continue;
    const quantity = m[1] ? parseInt(m[1], 10) : 1;
    if (!quantity || quantity < 1) continue;
    // Strip leading articles + any payment phrasing so "pay by card" can't
    // become a menu item; drop parts that were ONLY payment phrasing.
    const name = m[2]
      .trim()
      .replace(/^(?:a|an|the)\s+/i, '')
      .replace(PAYMENT_PHRASE_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (name) items.push({ name, quantity });
  }
  return items;
}

/** LLM parse: robust extraction of "2 butter naan, 1 paneer tikka" phrasing. */
export async function parseFoodOrderItems(text: string): Promise<FoodOrderItem[] | null> {
  // Fast deterministic path first.
  const fast = parseItemsRegex(text);
  if (fast.length) return fast;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const system = [
    'You extract food order items from casual chat messages.',
    'Examples: "order me paneer tikka and 2 butter naan" → items: [{name:"paneer tikka",quantity:1},{name:"butter naan",quantity:2}].',
    'Respond with JSON ONLY: {"items":[{"name":"...","quantity":number}]}.',
    '- quantity defaults to 1 when unspecified.',
    '- Do NOT invent items. If no food items can be identified, return {"items":[]}.',
  ].join('\n');

  try {
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    });
    const raw = res.choices[0]?.message?.content || '{}';
    const data = JSON.parse(raw);
    if (!Array.isArray(data.items)) return null;
    const items: FoodOrderItem[] = [];
    for (const it of data.items) {
      if (typeof it?.name !== 'string' || !it.name.trim()) continue;
      const quantity = Math.max(1, parseInt(it.quantity ?? 1, 10) || 1);
      items.push({ name: it.name.trim(), quantity });
    }
    return items.length ? items : null;
  } catch (err) {
    console.warn('[FoodOrder] LLM item parse failed:', err);
    return null;
  }
}

function parseRestaurants(text: string): ParsedRestaurant[] {
  const out: ParsedRestaurant[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\d+\.\s+(.+?)\s+—\s+.+?\|\s+([\d.]+)★\s+\|\s+(\d+)\s*min\s+\|.*?\(ID:\s*(\d+)\)/);
    if (m) {
      out.push({
        name: m[1].replace(/\s*\(Ad\)\s*$/, '').trim(),
        rating: parseFloat(m[2]),
        minutes: parseInt(m[3], 10),
        id: m[4],
      });
    }
  }
  return out;
}

function parseMenuItems(text: string): ParsedMenuItem[] {
  const out: ParsedMenuItem[] = [];
  for (const line of text.split('\n')) {
    // Scoped responses: "1. Paneer Tikka — ₹290 | Veg (ID: 205574251)"
    // Unscoped responses append the restaurant: "... | 4.1★ | New Balaji (restaurantId: 54441) (ID: 13640113)".
    const m = line.match(/^\s*\d+\.\s+(.+?)\s+—\s+₹([\d,]+)\s+\|.*?(?:restaurantId:\s*(\d+))?.*?\(ID:\s*(\d+)\)/);
    if (m) {
      out.push({
        name: m[1].trim(),
        price: parseFloat(m[2].replace(/,/g, '')),
        restaurantId: m[3] || undefined,
        id: m[4],
      });
    }
  }
  return out;
}

/**
 * Score how well a candidate name matches the requested query (higher = better).
 * Exact equality wins; a candidate that IS the query ("Paneer Tikka") beats a
 * candidate that merely contains it plus extra words ("Paneer Tikka Pizza").
 */
export function nameRelevanceScore(candidate: string, query: string): number {
  const c = candidate.toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (!c || !q) return 0;
  if (c === q) return 100;
  const qWords = q.split(/[^a-z0-9]+/).filter(Boolean);
  const cWords = c.split(/[^a-z0-9]+/).filter(Boolean);
  if (!qWords.length || !cWords.length) return 0;
  const allQueryWordsInCandidate = qWords.every((w) => cWords.includes(w));
  const allCandidateWordsInQuery = cWords.every((w) => qWords.includes(w));
  if (allCandidateWordsInQuery) return 95; // candidate ⊆ query: "paneer tikka" for "paneer tikka"
  if (allQueryWordsInCandidate) {
    const extraWords = Math.max(0, cWords.length - qWords.length);
    return Math.max(50, 85 - extraWords * 15); // query ⊆ candidate, penalize extras
  }
  const overlap = qWords.filter((w) => cWords.includes(w)).length / qWords.length;
  return Math.round(overlap * 45);
}

/** Pick the candidate whose name best matches the query (null when nothing overlaps). */
export function pickBestMatch<T>(candidates: T[], query: string, nameOf: (t: T) => string): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = nameRelevanceScore(nameOf(c), query);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * LLM pass to fix dish-name typos so menu searches find them
 * ("paner tikka" → "paneer tikka", "chiken biryani" → "chicken biryani").
 */
export async function normalizeFoodItems(items: FoodOrderItem[]): Promise<FoodOrderItem[] | null> {
  if (!items.length || !process.env.OPENAI_API_KEY) return null;
  try {
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You correct misspelled Indian food/grocery item names for a menu search.',
            'Fix typos and normalize names — e.g. "paner tikka" → "paneer tikka", "chiken biryani" → "chicken biryani", "amul mlik" → "amul milk".',
            'Do not add, remove, merge, or reorder items. Preserve quantities exactly.',
            'Respond with JSON ONLY: {"items":[{"name":"...","quantity":number}]}',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(items) },
      ],
    });
    const data = JSON.parse(res.choices[0]?.message?.content || '{}');
    if (!Array.isArray(data.items)) return null;
    const out: FoodOrderItem[] = [];
    for (const it of data.items) {
      if (typeof it?.name !== 'string' || !it.name.trim()) continue;
      out.push({ name: it.name.trim(), quantity: Math.max(1, parseInt(it.quantity ?? 1, 10) || 1) });
    }
    return out.length === items.length ? out : null; // same item count or skip
  } catch (err) {
    console.warn('[FoodOrder] dish-name normalization failed:', err);
    return null;
  }
}

/** Return the first saved address (id + label) or null. */
async function pickAddress(): Promise<{ id: string; label: string } | null> {
  const res = await callMcpTool(FOOD_MCP, 'get_addresses', {});
  if (!res.ok) return null;
  for (const line of (res.text || '').split('\n')) {
    const m = line.match(/\(ID:\s*([A-Za-z0-9]+)\)/);
    if (m && /^\s*\d+\./.test(line)) {
      return { id: m[1], label: line.replace(/^\s*\d+\.\s*/, '').slice(0, 80) };
    }
  }
  return null;
}

/**
 * Resolve the order (items → address → most-relevant restaurant → cart lines).
 * Returns either a PendingOrder or an error reply string.
 * `itemsOverride` supplies pre-parsed items from the Purchase Director (OpenAI
 * already corrected typos there); when absent the raw text is parsed and then
 * passed through a spelling-normalization pass so "paner tikka" still finds
 * restaurants.
 */
async function resolveOrder(
  ctx: FoodOrderContext,
  text: string,
  itemsOverride?: FoodOrderItem[]
): Promise<PendingOrder | string> {
  let items = itemsOverride && itemsOverride.length ? itemsOverride : await parseFoodOrderItems(text);
  if (!items || !items.length) {
    return '🍽️ I couldn\'t figure out what to order. Try: `order me paneer tikka and 2 butter naan`';
  }
  // Fix typos when the items came from the raw regex parse ("paner tikka" →
  // "paneer tikka") so the restaurant/menu searches actually find them.
  if (!itemsOverride) {
    const corrected = await normalizeFoodItems(items);
    if (corrected) items = corrected;
  }

  const address = await pickAddress();
  if (!address) {
    return '📍 No saved delivery address found. Add one in the Swiggy app, then try again.';
  }

  // Main item drives the restaurant search. Dish names like "butter naan"
  // don't match `search_restaurants` (it wants a restaurant/cuisine query), so
  // try each item in order until one yields restaurants, keeping the union.
  let restaurants: ParsedRestaurant[] = [];
  let queriedFor = items[0].name;
  for (const it of items) {
    const restRes = await callMcpTool(FOOD_MCP, 'search_restaurants', {
      query: it.name,
      addressId: address.id,
      limit: 10,
    });
    if (!restRes.ok) {
      return `🔍 Couldn't search restaurants for "${it.name}": ${restRes.error}`;
    }
    const found = parseRestaurants(restRes.text || '');
    if (found.length) {
      restaurants = found;
      queriedFor = it.name;
      break;
    }
  }
  if (!restaurants.length) {
    return `😕 No restaurants found for any of: ${items.map((i) => i.name).join(', ')}. Try a dish name instead.`;
  }

  // Relevance beats rating: `search_restaurants` returns matches in relevance
  // order, so probe the top candidates' menus for the main dish and pick the
  // restaurant whose menu has the BEST match — not merely the first with any
  // hit. A 3.9★ restaurant with "Paneer Tikka" beats a 4.5★ one whose closest
  // menu hit is "Paneer Tikka Pizza". Early-exit on a near-exact (≥90) match
  // keeps the common case to a single probe within the MCP call budget.
  let best: ParsedRestaurant | null = null;
  let mainMatch: ParsedMenuItem | null = null;
  let bestScore = 0;
  for (const r of restaurants.slice(0, 3)) {
    const menuRes = await callMcpTool(FOOD_MCP, 'search_menu', {
      query: items[0].name,
      addressId: address.id,
      restaurantIdOfAddedItem: r.id,
      limit: 5,
    });
    const matches = menuRes.ok ? parseMenuItems(menuRes.text || '') : [];
    const scoped = matches.filter((m) => !m.restaurantId || m.restaurantId === r.id);
    const match = pickBestMatch(scoped, items[0].name, (m) => m.name);
    if (match) {
      const score = nameRelevanceScore(match.name, items[0].name);
      if (score > bestScore) {
        bestScore = score;
        best = r;
        mainMatch = match;
      }
      if (score >= 90) break; // near-exact — this restaurant is clearly the one
    }
  }
  if (!best) best = restaurants[0]; // no probe matched — keep API relevance order anyway

  // Find every item at the chosen restaurant (best-relevance name match wins,
  // e.g. "Paneer Tikka" over "Paneer Tikka Pizza").
  const cartLines: CartLine[] = [];
  const missing: string[] = [];
  const addItem = (it: FoodOrderItem, matches: ParsedMenuItem[]) => {
    const scoped = matches.filter((m) => !m.restaurantId || m.restaurantId === best!.id);
    const match = pickBestMatch(scoped, it.name, (m) => m.name);
    if (match) {
      cartLines.push({ itemId: match.id, quantity: it.quantity, itemName: match.name, price: match.price });
    } else {
      missing.push(it.name);
    }
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // Main dish already matched while probing for the restaurant — reuse it so
    // we don't re-search the same menu.
    if (i === 0 && mainMatch) {
      cartLines.push({ itemId: mainMatch.id, quantity: it.quantity, itemName: mainMatch.name, price: mainMatch.price });
      continue;
    }
    const menuRes = await callMcpTool(FOOD_MCP, 'search_menu', {
      query: it.name,
      addressId: address.id,
      restaurantIdOfAddedItem: best.id,
      limit: 5,
    });
    addItem(it, menuRes.ok ? parseMenuItems(menuRes.text || '') : []);
  }

  if (!cartLines.length) {
    return `😕 None of those items are available at **${best.name}** (${best.rating}★). Try a different order.`;
  }

  return { ctx, items, address, restaurant: best, queriedFor, cartLines, missing, method: null, createdAt: Date.now() };
}

function itemLines(cartLines: CartLine[]): string {
  return cartLines.map((c) => `  • ${c.itemName}${c.price ? ` ₹${c.price}` : ''} ×${c.quantity}`).join('\n');
}

/** Estimated order total (₹) from menu prices — used for the Prava session. */
function orderTotal(cartLines: CartLine[]): number {
  return cartLines.reduce((sum, c) => sum + (c.price || 0) * c.quantity, 0);
}

/** Ask the user to pick a payment method (order parked in pending store). */
function askPaymentMethodReply(p: PendingOrder): string {
  const missingNote = p.missing.length ? `\n_Note: couldn't find ${p.missing.join(', ')} at this restaurant._` : '';
  return (
    `🍽️ *Ready to order from **${p.restaurant.name}** (${p.restaurant.rating}★, ~${p.restaurant.minutes} min)* — best match for "${p.queriedFor}".\n\n` +
    `📦 *Items*:\n${itemLines(p.cartLines)}${missingNote}\n\n` +
    `💳 *How would you like to pay?*\n` +
    `  • Reply **cash** → Cash on Delivery\n` +
    `  • Reply **upi** → pay via UPI\n` +
    `  • Reply **card** → 🔒 secure Prava payment link\n\n` +
    `_Reply **cancel** to drop this order._`
  );
}

/**
 * Cash/COD chain: update cart → payment options → place order.
 * Returns the chat reply (Markdown) plus whether the order was actually placed
 * (so callers can decide whether to keep the pending entry retryable).
 * `paymentLabel` overrides the shown payment method (used when a Prava card
 * approval already settled payment).
 */
async function placeFoodOrderCod(
  p: PendingOrder,
  paymentLabel = 'Cash (COD)',
  /** Force the MCP payment method (Cash / UPI); auto-detected when omitted. */
  preferredMethod?: 'Cash' | 'UPI'
): Promise<{ ok: boolean; text: string }> {
  const { restaurant, address, cartLines, missing, queriedFor } = p;

  // Safety gate: don't place REAL-money orders unless explicitly enabled.
  if (process.env.SWIGGY_AUTO_ORDER !== '1') {
    return {
      ok: false,
      text:
        `🍽️ *Ready to order from **${restaurant.name}** (${restaurant.rating}★, ~${restaurant.minutes} min)* — best match for "${queriedFor}".\n\n` +
        `📦 *Items*:\n${itemLines(cartLines)}\n\n` +
        `💵 *Payment*: ${paymentLabel}\n\n` +
        `⚠️ Auto-ordering is currently *off* (set \`SWIGGY_AUTO_ORDER=1\` to enable live orders).`,
    };
  }

  const cartRes = await callMcpTool(FOOD_MCP, 'update_food_cart', {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    addressId: address.id,
    cartItems: cartLines.map((c) => ({ itemId: c.itemId, quantity: c.quantity })),
  });
  if (!cartRes.ok) {
    return { ok: false, text: `🛒 Cart update at **${restaurant.name}** failed: ${cartRes.error}` };
  }

  // Payment options → prefer Cash (COD) for sandbox ordering. Fail loudly if
  // the merchant can't serve payment options instead of guessing.
  const payRes = await callMcpTool(FOOD_MCP, 'get_payment_options', { addressId: address.id });
  if (!payRes.ok) {
    return {
      ok: false,
      text: `💳 Couldn't fetch payment options at **${restaurant.name}**: ${payRes.error}\n\nItems are in your Swiggy cart — finish manually if you'd like.`,
    };
  }
  const payText = payRes.text || '';
  const payMethod =
    preferredMethod || (/Cash/i.test(payText) || /COD/i.test(payText) ? 'Cash' : 'UPI');

  const orderRes = await callMcpTool(FOOD_MCP, 'place_food_order', {
    addressId: address.id,
    paymentMethod: payMethod,
    noteToRestaurant: 'SubShield auto-order',
  });

  const orderRef = orderRes.ok
    ? (orderRes.text || '').match(/(?:order\s*(?:id|number|#)\s*[:#]?\s*[A-Za-z0-9-]{4,})/i)?.[0]
    : undefined;

  const lines = `📦 *Items*:\n${itemLines(cartLines)}`;
  const missingNote = missing.length ? `\n_Note: couldn't find ${missing.join(', ')} at this restaurant._` : '';

  if (orderRes.ok) {
    return {
      ok: true,
      text:
        `✅ *Order placed via Swiggy!*\n\n` +
        `🏪 *Restaurant*: ${restaurant.name} (${restaurant.rating}★, ~${restaurant.minutes} min)\n` +
        `${lines}${missingNote}\n\n` +
        `📍 *Deliver to*: ${address.label}\n` +
        `💵 *Payment*: ${paymentLabel}\n` +
        (orderRef ? `🧾 ${orderRef}\n` : '') +
        `I'll track the order and keep you posted.`,
    };
  }

  return {
    ok: false,
    text:
      `⚠️ *Order attempt did not complete* (sandbox expected).\n\n` +
      `🏪 *Chosen*: **${restaurant.name}** (${restaurant.rating}★, ~${restaurant.minutes} min) — best match for "${queriedFor}"\n` +
      `${lines}\n\n` +
      `📍 *Deliver to*: ${address.label}\n\n` +
      `❌ *At checkout*: ${orderRes.error || 'Unknown merchant error'}\n\n` +
      (missing.length ? `_Couldn't find: ${missing.join(', ')}_\n\n` : '') +
      `I've left the items in your Swiggy cart so you can finish manually if you'd like.`,
  };
}

/** Card path: create a Prava mandate session and return the secure link reply. */
async function startPravaForFood(p: PendingOrder): Promise<string> {
  const total = orderTotal(p.cartLines);
  const safeTotal = total > 0 ? total : 1; // never mint a zero-amount session
  try {
    const session = await pravaClient.createMandateSession({
      userId: p.ctx.userId,
      userEmail: chatEmailForUser(p.ctx.userId),
      vendorName: p.restaurant.name,
      vendorDomain: 'swiggy.com',
      amount: safeTotal,
      currency: 'INR',
      description: `Swiggy food order: ${p.items.map((i) => `${i.name} ×${i.quantity}`).join(', ')}`,
    });

    p.method = 'card';
    p.pravaSessionId = session.sessionId;
    p.paymentLink = session.iframeUrl;
    await savePendingOrder(p.ctx.chatId, p);

    const totalNote = total > 0 ? `💰 *Total*: ₹${total.toLocaleString('en-IN')}\n` : '';
    return (
      `💳 *Pay by card via Prava — secure link*\n\n` +
      `🏪 *Restaurant*: ${p.restaurant.name} (${p.restaurant.rating}★, ~${p.restaurant.minutes} min)\n` +
      `📦 *Items*:\n${itemLines(p.cartLines)}\n` +
      `${totalNote}\n` +
      `🔒 Approve the payment here (your card stays in Prava's vault — never in chat):\n${session.iframeUrl}\n\n` +
      `Once you've approved, reply **done** and I'll place your order.`
    );    } catch (err: any) {
      return `❌ Couldn't start the Prava payment: ${err?.message || err}\n\nYou can still reply **cash** for Cash-on-delivery instead.`;
    }
}

/**
 * Handle a follow-up reply for a pending food order:
 *  - "cash" / "cod"           → place via Cash-on-delivery
 *  - "card" / "upi"           → create Prava session + secure link (then "done")
 *  - "done" (after card)      → poll Prava result, then finalize the order
 *  - "cancel"                 → drop the pending order
 * Returns null when the message is NOT an answer to a pending payment question.
 */
/** Strict bare payment answers (anchored so "cash" alone triggers, not a
 *  product-tracking message that merely contains the word). Exported so the
 *  Zepto engine and the central chat-commands hint reuse the same contract. */
export const ANSWER_RE = /^\s*(?:cash|cod|card|upi|done|approved|paid|placed|go ahead|cancel|never mind|forget|drop it|nevermind)[.!]*\s*$/i;

/** "ok"/"yes" alone are too ambiguous to finalize a paid order — require an
 *  explicit finalize word. */
export const FINALIZE_RE = /^\s*(?:done|approved|paid|placed|go ahead)[.!]*\s*$/i;

export async function resolvePendingFoodOrder(chatId: string, text: string): Promise<string | null> {
  const pending = await getPendingOrder(chatId);

  // No pending food order on record — return null so the OTHER engines
  // (Zepto / product) get a chance to resolve their own pending orders.
  // The generic "no pending order" hint is emitted centrally in
  // chat-commands.ts after every resolver has had its turn.
  if (!pending) return null;

  const t = text.trim().toLowerCase();

  if (/^\s*(?:cancel|never mind|forget|drop it|nevermind)[.!]*\s*$/i.test(t)) {
    await removePendingOrder(chatId);
    return `🚫 Order cancelled.`;
  }

  if (pending.method === 'card') {
    // Awaiting "done" after the user approved the Prava link.
    if (FINALIZE_RE.test(t)) {
      const sessionId = pending.pravaSessionId!;

      // Poll briefly for the Prava result — approved once we see the one-time
      // credential (awaiting_result) or a closed session.
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
        await removePendingOrder(chatId);
        return `❌ *Prava payment failed.*\n\nYour order was not placed. Reply with the order again, or choose **cash** instead.`;
      }
      if (status !== 'awaiting_result' && status !== 'completed') {
        // Keep the pending entry — the user can reply "done" again once they
        // finish approving on the Prava page.
        return `⏳ I haven't seen your Prava approval yet. Open the secure link and approve it, then reply **done** again.`;
      }

      // Retrieve raw payment result from Prava containing the one-time card credential
      let raw: any = null;
      try {
        raw = await pravaClient.fetchRawPaymentResultForExecutor(sessionId);
        console.log('[FoodOrder] Raw fetchRawPaymentResultForExecutor response:', JSON.stringify(raw, null, 2));
      } catch (err) {
        console.warn('[FoodOrder] Failed to fetch raw payment result:', err);
      }

      // Extract one-time credential (PAN, CVV, Expiry, Cryptogram)
      const { extractOneTimeCredential } = await import('./auto-buy');
      const { executeSwiggyWebCheckout } = await import('./merchant-executor');
      const credData = extractOneTimeCredential(raw);

      if (!credData) {
        await removePendingOrder(chatId);
        return `❌ *Prava payment credential unavailable.*\n\nCould not extract one-time card credentials for session \`${sessionId}\`. Order was not placed on Swiggy.`;
      }

      // Execute real card checkout via Swiggy Web automation using the Prava one-time credential
      const totalAmt = orderTotal(pending.cartLines);
      const cardResult = await executeSwiggyWebCheckout(credData.credential, {
        amount: totalAmt,
        restaurantName: pending.restaurant.name,
        deliveryAddress: pending.address.label,
      });

      const isApproved = cardResult.status === 'approved';

      // Report transaction outcome back to Prava based strictly on real card execution result
      try {
        await pravaClient.reportTransactionStatus(sessionId, {
          txnRefId: credData.txnRefId,
          txnStatus: isApproved ? 'APPROVED' : 'DECLINED',
          amountPaid: credData.amount || String(totalAmt),
          authorizationCode: isApproved ? 'SWIGGY_CARD_OK' : undefined,
          responseCode: isApproved ? '00' : '05',
        });
      } catch (reportErr) {
        console.warn('[FoodOrder] Failed to report Prava transaction status:', reportErr);
      }

      if (isApproved) {
        await removePendingOrder(chatId);
        return (
          `✅ *Swiggy card order placed successfully via Prava!*\n\n` +
          `🏪 *Restaurant*: ${pending.restaurant.name}\n` +
          `💳 *Payment*: Prava card (Token: \`•••• ${credData.credential.pan.slice(-4)}\`)\n` +
          (cardResult.orderReference ? `🧾 Order ID: ${cardResult.orderReference}\n` : '') +
          `Detail: ${cardResult.detail}`
        );
      }

      return (
        `⚠️ *Swiggy card order did not complete*\n\n` +
        `🏪 *Chosen*: **${pending.restaurant.name}**\n` +
        `💳 *Prava Card*: Tokenized credential issued (\`•••• ${credData.credential.pan.slice(-4)}\`)\n` +
        `❌ *Checkout Result*: ${cardResult.detail}\n\n` +
        `The card charge was reported as DECLINED to Prava so no funds were settled.`
      );
    }

    // Allow switching away from card: if the user says "cash" or "upi" while
    // in the card flow, reset the method and process as a fresh payment answer.
    const switchMethod = detectPaymentMethod(t);
    if (switchMethod === 'cash') {
      pending.method = null; // reset so placeFoodOrderCod doesn't see 'card'
      const reply = await placeFoodOrderCod(pending);
      if (reply.ok) await removePendingOrder(chatId);
      return reply.text;
    }
    if (switchMethod === 'upi') {
      pending.method = null;
      const reply = await placeFoodOrderCod(pending, 'UPI', 'UPI');
      if (reply.ok) await removePendingOrder(chatId);
      return reply.text;
    }
    return null;
  }

  // No method chosen yet — interpret the answer.
  const method = detectPaymentMethod(t);
  if (method === 'cash') {
    const reply = await placeFoodOrderCod(pending);
    // Only drop the pending entry on a confirmed placement — a sandbox
    // merchant error should leave it retryable (or switchable to upi/card).
    if (reply.ok) await removePendingOrder(chatId);
    return reply.text;
  }
  if (method === 'upi') {
    const reply = await placeFoodOrderCod(pending, 'UPI', 'UPI');
    if (reply.ok) await removePendingOrder(chatId);
    return reply.text;
  }
  if (method === 'card') {
    return startPravaForFood(pending);
  }
  return null; // not a payment answer — let other intent handlers run
}

/**
 * Order food from chat text. Returns the chat reply (Markdown).
 * `itemsOverride` supplies items already parsed + typo-corrected by the
 * Purchase Director (OpenAI); when absent the text is parsed here. Picks the
 * most-relevant restaurant for the main dish (relevance beats rating), scopes
 * menu search to it, adds everything to the cart, then asks cash/upi/card (or
 * uses the method already mentioned in the message).
 */
export async function orderFoodFromChat(
  text: string,
  ctx: FoodOrderContext,
  itemsOverride?: FoodOrderItem[]
): Promise<string> {
  const resolved = await resolveOrder(ctx, text, itemsOverride);
  if (typeof resolved === 'string') return resolved;

  const method = detectPaymentMethod(text);
  if (method === 'cash') {
    return (await placeFoodOrderCod(resolved)).text;
  }
  if (method === 'upi') {
    return (await placeFoodOrderCod(resolved, 'UPI', 'UPI')).text;
  }
  if (method === 'card') {
    return startPravaForFood(resolved);
  }

  // Unspecified → park the order and ask.
  await savePendingOrder(ctx.chatId, resolved);
  return askPaymentMethodReply(resolved);
}

// ─── Dashboard console snapshot ──────────────────────────────────────────────

export interface PendingFoodOrderSummary {
  engine: 'food';
  chatId: string;
  userId: string;
  channel: string;
  items: FoodOrderItem[];
  restaurant: { name: string; rating: number; minutes: number };
  addressLabel: string;
  total: number;
  method: 'cash' | 'card' | 'upi' | null;
  pravaSessionId?: string;
  paymentLink?: string;
  createdAt: number;
  ageSeconds: number;
  /** Human status for the console. */
  status: 'awaiting_payment_method' | 'awaiting_prava_approval' | 'placing';
}

/** Snapshot live pending food orders (serializable, oldest first). */
export function listPendingFoodOrders(): PendingFoodOrderSummary[] {
  const out: PendingFoodOrderSummary[] = [];
  const now = Date.now();
  for (const [chatId, p] of pendingOrders) {
    if (now - p.createdAt > PENDING_TTL_MS) {
      pendingOrders.delete(chatId); // evict stale entries while listing
      continue;
    }
    out.push({
      engine: 'food',
      chatId,
      userId: p.ctx.userId,
      channel: p.ctx.channel,
      items: p.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      restaurant: { name: p.restaurant.name, rating: p.restaurant.rating, minutes: p.restaurant.minutes },
      addressLabel: p.address.label,
      total: orderTotal(p.cartLines),
      method: p.method,
      pravaSessionId: p.pravaSessionId,
      paymentLink: p.paymentLink,
      createdAt: p.createdAt,
      ageSeconds: Math.floor((now - p.createdAt) / 1000),
      status: p.method === 'card' ? 'awaiting_prava_approval' : p.method ? 'placing' : 'awaiting_payment_method',
    });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

