import { addTrackedProduct } from './price-tracker';
import { parseChatIntent, formatPrice } from './chat-intent';
import { looksLikeFoodOrder, orderFoodFromChat, resolvePendingFoodOrder, ANSWER_RE } from './food-order';
import { orderZeptoFromChat, resolvePendingZeptoOrder } from './zepto-order';
import { orderProductFromChat, resolvePendingProductOrder } from './product-order';
import { looksLikeOrderRequest, directPurchaseRequest, describePlan } from './purchase-director';
import { redactPII } from './utils';
import type { ChatChannel } from './types';

export interface ChatContext {
  userId: string;
  channel: ChatChannel;
  chatId: string;
}

const WELCOME_TEXT = `👋 Welcome to SubShield Price Tracker & Prava Auto-Purchase Bot!

*📦 Track a product + target price:*
"buy this when price reaches 2700 https://amazon.in/dp/B09QWY7JYK"
"track the mouse if it goes under 2000"

*🛍️ Order anything — I'll decide where from (OpenAI):*
"order me paneer tikka and 2 butter naan"      → Swiggy (food)
"order me amul milk and bread"                 → Zepto (groceries)
"order me a gaming mouse within 2000 - 3000"   → Shopify/Amazon via Prava

When a price hits your target, SubShield starts a Prava buy order and sends you a 🔒 secure payment link. You approve it there — never send card details in chat.

Food/grocery orders: I'll ask **cash**, **upi**, or **card** — cash is Cash-on-delivery, upi is UPI, card is a 🔒 secure Prava link you approve yourself. Product orders use Prava by default.`;

const HELP_TEXT = `🤖 *SubShield Bot*

*📦 Track a product:*
\`buy this when price reaches 2700 https://amazon.in/...\`
\`https://item.com/product 49.99\`

*🍽️ Order food (Swiggy, best-matching restaurant):*
\`order me paneer tikka and 2 butter naan\`
\`i want 1 chicken biryani and 2 butter naan\`

*🛒 Order groceries (Zepto):*
\`order me amul milk and 2 bread\`

*🛍️ Order a product (Shopify/Amazon via Prava):*
\`order me a gaming mouse within 2000 - 3000\`

When the price reaches your target, SubShield starts a Prava buy order and sends you the payment link to approve.

Food/grocery orders: I'll ask **cash**, **upi**, or **card** — cash is Cash-on-delivery, upi is UPI, card is a 🔒 secure Prava link. Reply **done** after approving a card payment. Product orders use Prava by default.`;

/**
 * Process an incoming chat message and return the reply text.
 * Channel-agnostic — used by the Telegram webhook AND the Linq webhook.
 */
export async function processChatMessage(text: string, ctx: ChatContext): Promise<string> {
  const trimmed = (text || '').trim();

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
      `2️⃣ When the price hits your target, I send you a 🔒 secure payment link from Prava\n` +
      `3️⃣ You open it and enter your card on Prava's PCI-compliant hosted page (first time only)\n` +
      `4️⃣ I get a one-time tokenized card to complete the purchase — I never see your real card data\n\n` +
      `_Tip: you can delete the message you just sent — I don't store it. (My logs mask long digit sequences like card numbers.)_`;
  }

  // 💳 Payment-answer interception — resolves a pending order's cash/upi/card
  // choice (or "done" after a Prava approval, "cancel" to drop). Runs BEFORE
  // the order gates so short replies like "cash" / "done" are interpreted
  // against the pending order instead of being treated as intents.
  const foodAnswer = await resolvePendingFoodOrder(ctx.chatId, trimmed);
  if (foodAnswer) return foodAnswer;

  const zeptoAnswer = await resolvePendingZeptoOrder(ctx.chatId, trimmed);
  if (zeptoAnswer) return zeptoAnswer;

  const productAnswer = await resolvePendingProductOrder(ctx.chatId, trimmed);
  if (productAnswer) return productAnswer;

  // A bare payment answer ("cash" / "upi" / "done") with NO pending order on
  // record — the in-memory pending store resets between serverless cold
  // starts, so give a graceful hint instead of a confusing help dump.
  if (ANSWER_RE.test(trimmed)) {
    return `🤔 I don't have a pending order on record right now (my memory resets between messages).\n\nJust re-send your order — e.g. \`order me paneer tikka and 2 butter naan\` — and I'll ask you for payment again.`;
  }

  // 🧭 Purchase Director — the OpenAI routing layer. Any order-ish phrasing
  // with NO product URL goes here; OpenAI decides food → swiggy, groceries →
  // zepto, products → shopify/amazon (Prava by default). We never ask the
  // user where to order from.
  if (looksLikeOrderRequest(trimmed)) {
    const plan = await directPurchaseRequest(trimmed);
    if (plan) {
      console.log(`[ChatCommands] Directed order "${redactPII(trimmed)}" → ${describePlan(plan)}`);

      // Pass OpenAI's parsed (typo-corrected) items straight into the engine —
      // otherwise the raw chat text is re-parsed and "paner tikka" would stay
      // misspelled and find nothing.
      if (plan.category === 'food') {
        return orderFoodFromChat(trimmed, ctx, plan.items);
      }
      if (plan.category === 'grocery') {
        return orderZeptoFromChat(trimmed, ctx, plan.items);
      }
      return orderProductFromChat(plan, ctx);
    }

    // OpenAI unavailable — fall back to the food gate so "order me paneer
    // tikka" still works, then to help text.
    if (looksLikeFoodOrder(trimmed)) {
      return orderFoodFromChat(trimmed, ctx);
    }
    return HELP_TEXT;
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
    });

    return `🎯 *Price Tracker Enrolled!*\n\n` +
      `📦 *Product*: ${product.productName}\n` +
      `🔗 *URL*: ${product.productUrl}\n` +
      `💰 *Target*: ${formatPrice(product.targetPrice, product.currency)} (current: ${formatPrice(product.currentPrice, product.currency)})\n\n` +
      `SubShield is monitoring this via Steel Cloud Browser. When the price hits ${formatPrice(product.targetPrice, product.currency)}, a Prava buy order is started automatically and you'll get the payment link here to approve.`;
  } catch (err) {
    console.error(`[ChatCommands] Failed to enroll product for ${ctx.channel} chat ${ctx.chatId}:`, err);
    return `❌ Sorry, I couldn't enroll that product. Check the URL and try again.`;
  }
}

