import { addTrackedProduct } from './price-tracker';
import { parseChatIntent, parseProductUrl, formatPrice } from './chat-intent';
import type { ChatChannel } from './types';

function isElectronicsOrGeneralProduct(text: string): boolean {
  return /\b(?:mouse|keyboard|headphones|headset|laptop|phone|charger|cable|monitor|gpu|cpu|ram|ssd|hard drive|case|watch|gadget|camera|speaker|console|controller|tv)\b/i.test(text);
}

function looksLikeOrderRequest(text: string): boolean {
  return !parseProductUrl(text) &&
    /^\s*(?:please\s+)?(?:order|buy|get|bring|grab|i want|i need|can you order|deliver|send me|purchase)\b/i.test(text);
}

export interface ChatContext {
  userId: string;
  channel: ChatChannel;
  chatId: string;
  eventId?: string;
}

const WELCOME_TEXT = `👋 Welcome to SubShield Price Tracker!

*📦 Track a product + target price:*
"buy this when price reaches 2700 https://amazon.in/dp/B09QWY7JYK"
"track the mouse if it goes under 2000"

When a price reaches your target, SubShield records an alert. It does not start checkout or create a payment session from a scraped price.

Merchant ordering is unavailable while the authenticated, exact-quote workflow is being verified. Never send card details in chat.`;

const HELP_TEXT = `🤖 *SubShield Bot*

*📦 Track a product:*
\`buy this when price reaches 2700 https://amazon.in/...\`
\`https://item.com/product 49.99\`

When the target is observed, you receive an alert only. A fresh merchant quote and explicit confirmation will be required once ordering is enabled.

Merchant ordering remains locked during the safety rebuild.`;

/**
 * Process an incoming chat message and return the reply text.
 * Channel-agnostic — used by the Telegram webhook AND the Linq webhook.
 */
export async function processChatMessage(text: string, ctx: ChatContext): Promise<string> {
  const trimmed = (text || '').trim();

  if (trimmed === '__PAYMENT_DATA_REDACTED__') {
    return `🔒 *Please don't send card details in chat.*\n\nPayment data was removed before storage. Any future checkout will use Prava's hosted, PCI-compliant page after an exact quote and explicit confirmation.`;
  }

  if (trimmed.startsWith('/start') || trimmed.startsWith('/help')) {
    return WELCOME_TEXT;
  }

  // ⛔ NEVER accept card details in chat (Prava is Zero-PCI-Scope). If the
  // message looks like it contains a card number, warn and redirect to the
  // secure link flow instead of parsing it.
  if (/\b(?:\d[ -]?){15,16}\b/.test(trimmed)) {
    return `🔒 *Please don't send card details in chat.*\n\n` +
      `For your security (and PCI compliance), card numbers, CVV, and expiry are never collected in Telegram/Linq.\n\n` +
      `Here's how it works instead:\n\n` +
      `1️⃣ Send me a product link + target price — e.g. \`buy this when price reaches 2700 https://amazon.in/dp/B09QWY7JYK\`\n` +
      `2️⃣ When the price hits your target, I send an alert only\n` +
      `3️⃣ Checkout remains locked until a fresh merchant quote is reviewed and explicitly confirmed\n\n` +
      `_Tip: you can delete the message you just sent — I don't store it. (My logs mask long digit sequences like card numbers.)_`;
  }

  // Legacy chat ordering is retired, not merely hidden behind a feature flag.
  // The replacement consumes a durable purchase order in a worker after the
  // provider-contract and sandbox gates pass.
  if (looksLikeOrderRequest(trimmed)) {
    if (isElectronicsOrGeneralProduct(trimmed)) {
      return `📦 *Electronics & General Products*\n\n` +
        `"Gaming mouse" is an e-commerce item (not a Swiggy food dish!).\n\n` +
        `To track an electronics item like a gaming mouse within your budget:\n` +
        `1️⃣ Find your preferred gaming mouse on Amazon or Flipkart\n` +
        `2️⃣ Send the product URL + target price here:\n` +
        `   \`buy this when price reaches 2500 https://amazon.in/dp/...\`\n\n` +
        `SubShield will monitor the price and alert you when it drops into your target price!`;
    }

    return `🔒 Merchant ordering is currently disabled while per-user accounts, pinned provider contracts, and exact-quote execution are being verified.\n\nYou can still send a public product URL with a target price to create a read-only price alert.`;
  }

  // Price-tracker territory (URL present, or track/monitor phrasing).
  const intent = await parseChatIntent(trimmed);

  if (!intent.productUrl) {
    return HELP_TEXT;
  }

  if (intent.targetPrice === null) {
    return `I found a product link, but no target price. Say it like:\n\n\`buy this when price reaches 2700 ${intent.productUrl}\``;
  }

  try {
    const product = await addTrackedProduct({
      userId: ctx.userId,
      productUrl: intent.productUrl,
      targetPrice: intent.targetPrice,
      currency: intent.currency,
      channel: ctx.channel,
      chatId: ctx.chatId,
      eventId: ctx.eventId,
    });

    return `🎯 *Price Tracker Enrolled!*\n\n` +
      `📦 *Product*: ${product.productName}\n` +
      `🔗 *URL*: ${product.productUrl}\n` +
      `💰 *Target*: ${formatPrice(product.targetPrice, product.currency)} (current: ${formatPrice(product.currentPrice, product.currency)})\n\n` +
      `SubShield is monitoring this price. When it reaches ${formatPrice(product.targetPrice, product.currency)}, you'll receive an alert. Checkout will not start automatically.`;
  } catch (err) {
    console.error(`[ChatCommands] Failed to enroll product for ${ctx.channel} chat ${ctx.chatId}:`, err);
    return `❌ Sorry, I couldn't enroll that product. Check the URL and try again.`;
  }
}
