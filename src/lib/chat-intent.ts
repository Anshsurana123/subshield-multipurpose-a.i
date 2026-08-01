import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

/**
 * Natural-language intent parsing for chat messages.
 *
 * Two layers:
 *  1. Deterministic regex fast-path — handles bare domains (no https://),
 *     natural-language price phrases ("when price reaches 2700", "buy at $49"),
 *     and currency inference from the TLD (.in → INR).
 *  2. OpenAI fallback — when the regex can't confidently extract a URL+price,
 *     gpt-4o-mini parses the phrasing and returns structured JSON. The LLM
 *     output is validated before it's trusted.
 */

const CURRENCY_BY_TLD: Record<string, string> = {
  '.in': 'INR',
  '.co.uk': 'GBP',
  '.uk': 'GBP',
  '.de': 'EUR',
  '.fr': 'EUR',
  '.es': 'EUR',
  '.it': 'EUR',
  '.nl': 'EUR',
  '.co.jp': 'JPY',
  '.jp': 'JPY',
  '.ca': 'CAD',
  '.com.au': 'AUD',
  '.au': 'AUD',
  '.ae': 'AED',
  '.sg': 'SGD',
  '.ch': 'CHF',
  '.br': 'BRL',
  '.mx': 'MXN',
};

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$', INR: '₹', GBP: '£', EUR: '€', JPY: '¥',
  CAD: 'C$', AUD: 'A$', AED: 'AED ', SGD: 'S$', CHF: 'CHF ',
  BRL: 'R$', MXN: 'MX$',
};

export function formatPrice(amount: number, currency = 'USD'): string {
  const symbol = CURRENCY_SYMBOL[currency] || currency + ' ';
  return `${symbol}${amount.toFixed(2)}`;
}

/** Infer a currency code from a product URL's top-level domain. */
export function inferCurrency(productUrl: string): string {
  try {
    const host = new URL(productUrl).hostname.toLowerCase();
    for (const [tld, currency] of Object.entries(CURRENCY_BY_TLD)) {
      if (host.endsWith(tld)) return currency;
    }
  } catch { /* fall through */ }
  return 'USD';
}

function cleanUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?)\]]+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/**
 * Extract a product URL from chat text.
 * Handles full URLs AND bare domains (amazon.in/dp/... without https://).
 */
export function parseProductUrl(text: string): string | null {
  const full = text.match(/https?:\/\/[^\s]+/i);
  if (full) return cleanUrl(full[0]);

  // Bare domain: "amazon.in/Logitech-.../dp/B09QWY7JYK" (no protocol)
  const bare = text.match(/(?:^|\s)((?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?)/i);
  if (bare && /\.(?:com|in|co\.uk|co|org|net|io|de|fr|jp|ca|au|ae|sg|ch|br|mx|dev|app|shop|store)/i.test(bare[1])) {
    return cleanUrl(bare[1]);
  }
  return null;
}

/**
 * Extract a target price from chat text.
 * Handles: "2700", "₹2,700", "$49.99", "price reaches 2700", "buy at $49",
 * "under 2500", "when it drops below 2000". Ignores digits inside the URL.
 */
export function parseTargetPrice(text: string, productUrl: string | null): number | null {
  let body = text;
  if (productUrl) {
    // Drop both the full https:// form AND the raw protocol-less form
    // (e.g. "amazon.in/Logitech-..." without https://).
    body = body.replace(productUrl, ' ');
    body = body.replace(productUrl.replace(/^https?:\/\//, ''), ' ');
  }

  const pricePhrases = [
    /(?:when|if|once|whenever)\s+(?:price|it)?\s*(?:reaches|hits|drops?\s*(?:to|below|under)|is\s*(?:at|below|under)|goes\s*(?:below|under|to))\s*(?:₹|rs\.?|inr|us\$|\$|€|£)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:buy|get|grab|purchase|order)\b.{0,40}?(?:at|for|under|below)\s*(?:₹|rs\.?|inr|us\$|\$|€|£)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:under|below|less than|at most|max(?:imum)?|budget(?: of)?|target(?: of)?)\s*(?:₹|rs\.?|inr|us\$|\$|€|£)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:₹|rs\.?|inr|us\$|\$|€|£)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:^|\s)([\d,]+(?:\.\d{1,2})?)(?:\s|$)/,
  ];

  for (const re of pricePhrases) {
    const m = body.match(re);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(val) && val > 0 && val < 100_000_000) return val;
    }
  }
  return null;
}

export interface ParsedIntent {
  productUrl: string | null;
  targetPrice: number | null;
  currency: string;
  /** True when the intent was extracted by the LLM rather than regex. */
  usedLLM: boolean;
}

/**
 * OpenAI fallback: phrase the message into a structured intent when the
 * deterministic regex path fails to find a URL + price.
 * Returns null when the LLM can't identify a product-tracking intent.
 */
export async function parseIntentWithLLM(text: string): Promise<ParsedIntent | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const system = [
    'You extract product price-tracking intents from casual chat messages.',
    'A user may say things like "buy this when price reaches 2700 amazon.in/Logitech-...",',
    '"track the mouse if it goes under 2000", "grab it at 49.99 https://...".',
    'Respond with JSON ONLY, no prose:',
    '{',
    '  "action": "track" | "other",',
    '  "productUrl": "full url with https:// or empty string",',
    '  "targetPrice": number or null,',
    '  "currency": "INR" | "USD" | "EUR" | ... (from the url domain or context, default USD)',
    '}',
    'Rules:',
    '- action is "track" only if the user wants to buy/monitor a product at a price target.',
    '- productUrl must be a REAL url found in the message (with https:// prefixed). Empty string if none.',
    '- targetPrice is the number the user wants to pay or monitor (e.g. 2700, 49.99).',
    '- Do NOT invent URLs or prices. If missing, use null/empty.',
  ].join('\n');

  try {
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    });

    const raw = res.choices[0]?.message?.content || '{}';
    const data = JSON.parse(raw);

    if (data.action !== 'track') return null;

    let productUrl: string | null = null;
    if (typeof data.productUrl === 'string' && data.productUrl.trim()) {
      const u = parseProductUrl(data.productUrl.trim());
      if (u) productUrl = u;
    }

    let targetPrice: number | null = null;
    if (typeof data.targetPrice === 'number' && data.targetPrice > 0) {
      targetPrice = data.targetPrice;
    } else if (typeof data.targetPrice === 'string' && parseFloat(data.targetPrice) > 0) {
      targetPrice = parseFloat(data.targetPrice);
    }

    // Only trust ISO 4217 codes the Prava API actually supports; anything
    // else falls back to TLD inference so a bad LLM value can't break session creation.
    const KNOWN_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'AED', 'SGD', 'CHF', 'BRL', 'MXN'];
    const suggestedCurrency =
      typeof data.currency === 'string' && /^[A-Z]{3}$/.test(data.currency)
        ? data.currency.toUpperCase()
        : '';
    const currency =
      KNOWN_CURRENCIES.includes(suggestedCurrency)
        ? suggestedCurrency
        : productUrl
          ? inferCurrency(productUrl)
          : 'USD';

    return { productUrl, targetPrice, currency, usedLLM: true };
  } catch (err) {
    console.warn('[ChatIntent] OpenAI intent parse failed:', err);
    return null;
  }
}

/**
 * Parse a chat message into a product-tracking intent.
 * Tries deterministic regex first (fast, free), then falls back to the LLM.
 */
export async function parseChatIntent(text: string): Promise<ParsedIntent> {
  const productUrl = parseProductUrl(text);
  const targetPrice = productUrl ? parseTargetPrice(text, productUrl) : null;
  const currency = productUrl ? inferCurrency(productUrl) : 'USD';

  // Fast path: clean URL + explicit price → done, no LLM needed.
  if (productUrl && targetPrice !== null) {
    return { productUrl, targetPrice, currency, usedLLM: false };
  }

  // Ambiguous: let the LLM phrase it.
  const llm = await parseIntentWithLLM(text);
  if (llm) return llm;

  return { productUrl, targetPrice, currency, usedLLM: false };
}
