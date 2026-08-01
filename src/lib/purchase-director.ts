import OpenAI from 'openai';
import { parseProductUrl } from './chat-intent';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

/**
 * Purchase Director — the OpenAI routing layer for vague order requests.
 *
 * The chat engine cannot tell "order paneer tikka" (food) from "order me a
 * gaming mouse" (product) with regexes alone, and we deliberately do NOT ask
 * the user where to order from. So any order-ish phrasing with no product URL
 * is sent to OpenAI, which classifies it into a structured PurchasePlan:
 *
 *   - food    → merchant "swiggy"     (Swiggy Food MCP engine)
 *   - grocery → merchant "zepto"      (Zepto MCP engine)
 *   - product → merchant "shopify" or "amazon" (Prava-first product engine)
 *
 * The plan carries items + quantities, an optional price range ("within x - y"),
 * a search query for products, a payment-method hint, and the vendor URL the
 * OpenAI layer believes can fulfil the order. Downstream engines never re-ask
 * "where should I order from?" — they trust this routing.
 */

export type PurchaseCategory = 'food' | 'grocery' | 'product';
export type PurchaseMerchant = 'swiggy' | 'zepto' | 'shopify' | 'amazon';

export interface PurchaseItem {
  name: string;
  quantity: number;
}

export interface PurchasePlan {
  category: PurchaseCategory;
  merchant: PurchaseMerchant;
  /** Food/grocery items with quantities (empty for product orders). */
  items: PurchaseItem[];
  /** Product search query, e.g. "gaming mouse wireless" (product orders only). */
  productQuery: string;
  /** Optional price constraint, e.g. "within 2000 - 3000" → {min:2000,max:3000}. */
  minPrice: number | null;
  maxPrice: number | null;
  /** Realistic market estimate when min/max price are absent (e.g. 2499 for perfume). */
  estimatedPrice: number | null;
  currency: string;
  /** Payment hint the user mentioned (upi/card/cash) — null when unspecified. */
  paymentMethod: 'upi' | 'card' | 'cash' | null;
  /** Vendor URL the router believes fulfils the order (shopify store / amazon link). */
  vendorUrl: string | null;
  /** Short human reason for the routing decision (for logging/debug). */
  reason: string;
}

/** Quick gate — is this message order-ish phrasing with no product URL? */
export function looksLikeOrderRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Any product URL (full https:// OR bare domain like amazon.in/dp/...)
  // belongs to the price tracker, not a direct order — even if the message
  // starts with "buy" ("buy this when price reaches 2700 amazon.in/...").
  if (parseProductUrl(t)) return false;
  // Explicit track/monitor language belongs to the price tracker.
  // ("if"/"when"/"price" alone are NOT excluded — a conditional order like
  // "order me a gaming mouse if under 3000" should still reach OpenAI.)
  if (/\b(?:track|monitor|watch|notify|alert)\b/i.test(t)) return false;
  return /^\s*(?:please\s+)?(?:order|buy|get|bring|grab|i want|i need|can you order|order me|deliver|send me|purchase)\b/i.test(t);
}

const DIRECTOR_SYSTEM = [
  'You are the purchase router for an AI shopping assistant.',
  'The user wants to order something. Classify WHAT they want and WHERE it should be ordered from.',
  'NEVER ask the user for clarification — decide for them using these rules:',
  '',
  'CATEGORY + MERCHANT RULES:',
  '- If the request is FOOD (dishes, meals, biryani, pizza, naan, coffee, restaurant food) → category "food", merchant "swiggy".',
  '- If the request is GROCERIES / quick-commerce essentials (milk, bread, vegetables, eggs, snacks, household basics, 10-min delivery items) → category "grocery", merchant "zepto".',
  '- Everything else that is NOT food or grocery is a PHYSICAL PRODUCT → category "product", merchant "shopify". STRICT RULE: For product orders, stick STRICTLY to Shopify-powered stores ONLY. Never use Amazon or non-Shopify merchants for product orders.',
  '',
  'ITEM EXTRACTION:',
  '- Extract every item with its quantity. Quantity defaults to 1 when unspecified.',
  '- Correct typos and normalize names to what a menu/search would list (e.g. "paner tikka" → "paneer tikka", "chiken biriyani" → "chicken biryani", "amul mlik" → "amul milk"). The corrected name is what gets searched.',
  '- For product orders, put a concise, searchable product query in productQuery (e.g. "rock smelling perfume").',
  '- Do NOT invent items that are not in the message.',
  '',
  'PRICE RANGE & ESTIMATES:',
  '- Parse price constraints like "within 2000 - 3000", "between x and y", "under 2000", "max 1500" into minPrice/maxPrice. Use null when absent.',
  '- If minPrice/maxPrice are absent, provide a realistic typical retail market price estimate for the item in estimatedPrice (e.g. 2499 for perfume, 1800 for gaming mouse, 650 for coffee beans). Never estimate 1 or 0.',
  '',
  'VENDOR URL (STRICT SHOPIFY ONLY FOR PRODUCTS):',
  '- For category "product", include vendorUrl: a REAL Shopify-powered store product or search URL (e.g. https://www.boat-lifestyle.com/search?q=gaming+mouse or a known Shopify brand store URL). Do NOT output Amazon or non-Shopify URLs.',
  '- For food/grocery, vendorUrl should be null.',
  '',
  'PAYMENT:',
  '- If the user explicitly mentions a payment method ("pay by upi", "upi", "via card", "cash on delivery", "cod"), set paymentMethod accordingly. Otherwise null (the engine defaults to Prava for products and asks cash/card/upi for food).',
  '',
  'RESPOND WITH JSON ONLY:',
  '{',
  '  "category": "food" | "grocery" | "product",',
  '  "merchant": "swiggy" | "zepto" | "shopify",',
  '  "items": [{"name": "...", "quantity": 1}],',
  '  "productQuery": "...",',
  '  "minPrice": number | null,',
  '  "maxPrice": number | null,',
  '  "estimatedPrice": number | null,',
  '  "currency": "INR",',
  '  "paymentMethod": "upi" | "card" | "cash" | null,',
  '  "vendorUrl": "... real shopify url or null",',
  '  "reason": "one short sentence"',
  '}',
  '',
  'If the message is NOT a purchase request at all, respond with: {"category": null}',
].join('\n');

/**
 * Route a vague purchase request through OpenAI.
 * Returns null when the message isn't a purchase request or the API is down.
 */
export async function directPurchaseRequest(text: string): Promise<PurchasePlan | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const preferredModel = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
    let res;
    try {
      res = await openai.chat.completions.create({
        model: preferredModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: DIRECTOR_SYSTEM },
          { role: 'user', content: text },
        ],
      });
    } catch (modelErr: any) {
      console.warn(`[PurchaseDirector] Model ${preferredModel} failed (${modelErr?.message || modelErr}) — falling back to gpt-4o-mini`);
      res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: DIRECTOR_SYSTEM },
          { role: 'user', content: text },
        ],
      });
    }
    const raw = res.choices[0]?.message?.content || '{}';
    const data = JSON.parse(raw);

    if (!data.category || data.category === null) return null;

    const category: PurchaseCategory = ['food', 'grocery', 'product'].includes(data.category)
      ? data.category
      : 'product';
    const merchant: PurchaseMerchant = ['swiggy', 'zepto', 'shopify', 'amazon'].includes(data.merchant)
      ? data.merchant
      : category === 'food' ? 'swiggy' : category === 'grocery' ? 'zepto' : 'shopify';

    const items: PurchaseItem[] = Array.isArray(data.items)
      ? data.items
          .filter((it: any) => it && typeof it.name === 'string' && it.name.trim())
          .map((it: any) => ({
            name: it.name.trim().slice(0, 80),
            quantity: Math.max(1, Math.min(99, parseInt(it.quantity ?? 1, 10) || 1)),
          }))
      : [];

    const toPrice = (v: any): number | null => {
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
    };

    let minPrice = toPrice(data.minPrice);
    let maxPrice = toPrice(data.maxPrice);
    const estimatedPrice = toPrice(data.estimatedPrice);

    if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
      const tmp = minPrice;
      minPrice = maxPrice;
      maxPrice = tmp;
    }

    const currency =
      typeof data.currency === 'string' && /^[A-Z]{3}$/i.test(data.currency)
        ? data.currency.toUpperCase()
        : 'INR';

    const paymentMethod: 'upi' | 'card' | 'cash' | null =
      data.paymentMethod === 'upi' || data.paymentMethod === 'card' || data.paymentMethod === 'cash'
        ? data.paymentMethod
        : null;

    let vendorUrl: string | null = null;
    if (typeof data.vendorUrl === 'string' && /^https?:\/\//i.test(data.vendorUrl)) {
      vendorUrl = data.vendorUrl;
    }

    const reason =
      typeof data.reason === 'string' && data.reason.trim()
        ? data.reason.trim().slice(0, 200)
        : `${category} via ${merchant}`;

    return {
      category,
      merchant,
      items: category === 'product' ? [] : items,
      productQuery:
        typeof data.productQuery === 'string' && data.productQuery.trim()
          ? data.productQuery.trim().slice(0, 120)
          : items[0]?.name || '',
      minPrice,
      maxPrice,
      estimatedPrice,
      currency,
      paymentMethod,
      vendorUrl,
      reason,
    };
  } catch (err) {
    console.warn('[PurchaseDirector] OpenAI routing failed:', err);
    return null;
  }
}

/** Human-friendly summary of a plan (for replies/debugging). */
export function describePlan(plan: PurchasePlan): string {
  const price = plan.minPrice != null || plan.maxPrice != null
    ? ` (${plan.minPrice ?? ''} - ${plan.maxPrice ?? ''} ${plan.currency})`
    : '';
  if (plan.category === 'product') {
    return `Product: ${plan.productQuery}${price} → ${plan.merchant}`;
  }
  const items = plan.items.map((i) => `${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.name}`).join(', ');
  return `${plan.category === 'food' ? 'Food' : 'Groceries'}: ${items} → ${plan.merchant}`;
}
