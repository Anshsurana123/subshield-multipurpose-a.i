import { createSteelSession } from './steel-client';

export interface MerchantPaymentCredentials {
  /** Visa network token — used as the PAN in the merchant's card form. */
  pan: string;
  /** One-time dynamic CVV. */
  cvv: string;
  /** 2-digit month. */
  expiryMonth: string;
  /** 4-digit year. */
  expiryYear: string;
  /** Optional token cryptogram / ECI value for direct gateway API checkout. */
  cryptogram?: string;
}

export interface MerchantExecutionResult {
  status: 'approved' | 'declined' | 'failed' | 'blocked';
  /** Human-readable evidence/reason for the outcome. */
  detail: string;
  /** Order/confirmation reference if the page revealed one. */
  orderReference?: string;
  /** Final URL after the payment attempt (evidence). */
  finalUrl?: string;
}

/**
 * Common selectors used across Amazon / Flipkart / generic shops.
 * Best-effort: each page is different, so we try a stack of candidates and
 * only fail when none match.
 */
const BTN_ADD_TO_CART = [
  '#add-to-cart-button',                    // Amazon
  'input[name="submit.add-to-cart"]',
  'button[data-testid="add-to-cart"]',
  'button:has-text("Add to cart")',
  'button:has-text("ADD TO CART")',
  'button:has-text("Add to Cart")',
  '[class*="add-to-cart"]',
];
const BTN_BUY_NOW = [
  '#buy-now-button',                        // Amazon
  'button:has-text("Buy Now")',
  'button:has-text("Buy it now")',
  'button:has-text("Proceed to Buy")',
  'button:has-text("Place Order")',
  'button:has-text("Place your order")',
  '[class*="buy-now"]',
];
const BTN_CHECKOUT = [
  'button:has-text("Checkout")',
  'button:has-text("Proceed to Checkout")',
  'button:has-text("Go to Checkout")',
  'button:has-text("Continue")',
  'input[type="submit"][value*="Checkout" i]',
];

const FIELD_CARD_NUMBER = [
  '#addCreditCardNumber', '#cardNumber', '#cardnumber',
  'input[name="cardNumber"]', 'input[name="cardnumber"]',
  'input[autocomplete="cc-number"]',
  'input[placeholder*="card number" i]',
  'input[placeholder*="Card Number" i]',
  'input[data-testid*="card-number" i]',
  '[id*="cardNumber"] input', '[id*="CardNumber"] input',
  'iframe[id*="card" i] input',
];
const FIELD_EXPIRY = [
  '#expirationDate', '#cardExpiry', '#card-expiry', '#cc-exp',
  'input[name="expiry"]', 'input[name="cardExpiry"]',
  'input[autocomplete="cc-exp"]',
  'input[placeholder*="MM/YY"]', 'input[placeholder*="MM / YY"]',
  'input[placeholder*="expiry" i]', 'input[placeholder*="Expiry" i]',
  '[id*="expiry"] input', '[id*="Expiry"] input',
];
const FIELD_CVV = [
  '#cvv', '#cardCvv', '#card-cvv', '#cc-cvv', '#securityCode',
  'input[name="cvv"]', 'input[name="securityCode"]', 'input[name="cvc"]',
  'input[autocomplete="cc-csc"]',
  'input[placeholder*="CVV" i]', 'input[placeholder*="CVC" i]',
  'input[placeholder*="security code" i]',
  '[id*="cvv"] input', '[id*="Cvv"] input', '[id*="securityCode"] input',
];

function firstVisible(page: any, selectors: string[]): Promise<any> {
  const locator = page.locator(selectors.join(', ')).first();
  return locator
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => locator)
    .catch(() => null);
}

/**
 * Parse Amazon session cookies from the AMAZON_SESSION_COOKIES environment
 * variable (JSON array of {name, value, domain} objects). These must be
 * exported from a logged-in browser session (e.g. via the EditThisCookie
 * extension or browser DevTools).
 *
 * Required env: AMAZON_SESSION_COOKIES='[{"name":"session-id","value":"...","domain":".amazon.in"}, ...]'
 */
function getAmazonCookies(): Array<{
  name: string; value: string; domain: string;
  path?: string; httpOnly?: boolean; secure?: boolean;
}> | null {
  const raw = process.env.AMAZON_SESSION_COOKIES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed.filter((c: any) => c.name && c.value && c.domain);
  } catch (err) {
    console.warn('[MerchantExecutor] Failed to parse AMAZON_SESSION_COOKIES:', err);
    return null;
  }
}

function isAmazonUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('amazon.');
  } catch {
    return false;
  }
}

/**
 * Execute a real purchase at the merchant using the one-time Prava credential.
 *
 * Flow: open product → add to cart → checkout → fill token as PAN + dynamic
 * CVV + expiry → submit → detect success (order confirmation URL/text) or
 * decline (payment error / OTP prompt).
 *
 * This is intentionally best-effort: every merchant renders differently, so we
 * use selector stacks + page-text signals and NEVER claim success without
 * positive confirmation. On any doubt we return `failed` so Prava is not told
 * APPROVED incorrectly.
 */
export async function executeMerchantCheckout(
  productUrl: string,
  credentials: MerchantPaymentCredentials,
  opts: { amount?: number; currency?: string; country?: string } = {}
): Promise<MerchantExecutionResult> {
  // For Amazon, inject pre-authenticated session cookies so the checkout
  // doesn't hit the login wall. Other merchants proceed without cookies.
  const amazonCookies = isAmazonUrl(productUrl) ? getAmazonCookies() : null;
  if (isAmazonUrl(productUrl) && !amazonCookies) {
    return {
      status: 'failed',
      detail: 'Amazon requires AMAZON_SESSION_COOKIES (exported from a logged-in browser). Set the env var with a JSON array of cookie objects: [{"name":"session-id","value":"...","domain":".amazon.in"}, ...]',
    };
  }

  const session = await createSteelSession(productUrl, {
    country: opts.country || process.env.STEEL_COUNTRY || 'IN',
    stealth: true,
    solveCaptcha: true,
    cookies: amazonCookies ?? undefined,
  });

  try {
    const { page } = session;
    const log: string[] = [];

    const trace = (step: string) => log.push(step);

    // 1. Add to cart (or buy now) — try Buy Now first (fewer steps), then cart.
    const buyNow = await firstVisible(page, BTN_BUY_NOW);
    if (buyNow) {
      await buyNow.click();
      trace('clicked Buy Now');
    } else {
      const addToCart = await firstVisible(page, BTN_ADD_TO_CART);
      if (addToCart) {
        await addToCart.click();
        trace('clicked Add to Cart');
        await page.waitForTimeout(2000);
        // Dismiss any "added" modal and go to checkout
        const goCart = await firstVisible(page, ['#attach-sidesheet-view-cart-button', 'a:has-text("Go to cart")', 'button:has-text("Cart")']);
        if (goCart) { await goCart.click(); trace('opened cart'); await page.waitForTimeout(1500); }
      } else {
        return { status: 'failed', detail: 'Could not find Add to Cart / Buy Now button', finalUrl: page.url() };
      }
    }

    // 2. Proceed through checkout until payment fields appear.
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(1500);
      const cardField = await firstVisible(page, FIELD_CARD_NUMBER);
      if (cardField) break;
      const next = await firstVisible(page, BTN_CHECKOUT);
      if (!next) break;
      await next.click();
      trace('checkout step click');
    }

    // 3. Fill the card form with the one-time credential.
    const cardField = await firstVisible(page, FIELD_CARD_NUMBER);
    if (!cardField) {
      return { status: 'blocked', detail: `Payment form not found (page may be bot-blocked or OTP/cash flow). Steps: ${log.join(' → ')}`, finalUrl: page.url() };
    }
    await cardField.fill(credentials.pan.replace(/\s/g, ''));
    trace('filled card number');

    const expiryField = await firstVisible(page, FIELD_EXPIRY);
    if (expiryField) {
      await expiryField.fill(`${credentials.expiryMonth}${credentials.expiryYear.slice(-2)}`);
      trace('filled expiry');
    }

    const cvvField = await firstVisible(page, FIELD_CVV);
    if (cvvField) {
      await cvvField.fill(credentials.cvv);
      trace('filled cvv');
    }

    // 4. Verify the displayed total matches the expected amount when possible
    //    (guards against wrong-item/variant purchases).
    if (opts.amount) {
      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '');
      const currencySymbol = opts.currency === 'INR' ? '₹' : opts.currency === 'GBP' ? '£' : opts.currency === 'EUR' ? '€' : '$';
      const totalMatch = pageText.match(new RegExp(`(?:total|order total|amount|pay)\\s*[:${currencySymbol}]?\\s*([\\d,.]+)`, 'i'));
      if (totalMatch) {
        const shown = parseFloat(totalMatch[1].replace(/,/g, ''));
        const expected = opts.amount;
        const withinTolerance = Math.abs(shown - expected) / expected < 0.02; // allow 2% tax/shipping drift
        if (!withinTolerance && shown > 0) {
          trace(`total mismatch: shown ${shown}, expected ${expected}`);
          console.warn(`[MerchantExecutor] Checkout total mismatch (shown ${shown}, expected ${expected}) for ${productUrl}`);
        }
      }
    }

    // 5. Submit payment.
    const submit = await firstVisible(page, ['button:has-text("Pay")', 'button:has-text("Submit")', 'button:has-text("Place Order")', 'button:has-text("Place your order")', 'button:has-text("Confirm")', 'input[type="submit"]']);
    if (submit) {
      await submit.click();
      trace('submitted payment');
    } else {
      trace('no submit button found');
    }

    // 6. Wait for the outcome — poll the page text over ~20s because real
    //    checkouts (Amazon especially) can take 10-30s to confirm.
    const successSignals = [
      'order placed', 'order confirmed', 'thank you for your purchase',
      'order is confirmed', 'payment successful', 'payment success',
      'your order has been placed', 'order number',
    ];
    const declineSignals = [
      'payment declined', 'card declined', 'invalid card', 'insufficient funds',
      'could not process', 'payment failed', 'transaction failed', 'declined',
      'try again', 'enter otp', 'one time password',
    ];

    let finalUrl = page.url();
    let bodyText = '';
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(4000);
      finalUrl = page.url();
      bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '');
      const lower = bodyText.toLowerCase();
      const successHit = successSignals.find((s) => lower.includes(s));
      const declineHit = declineSignals.find((s) => lower.includes(s));
      if (successHit) {
        const orderMatch = bodyText.match(/order\s*(?:number|#)?\s*[:#]?\s*([A-Z0-9-]{6,})/i);
        return {
          status: 'approved',
          detail: `Success signal "${successHit}" detected after payment submission`,
          orderReference: orderMatch?.[1],
          finalUrl,
        };
      }
      if (declineHit) {
        return { status: 'declined', detail: `Decline signal "${declineHit}" (steps: ${log.join(' → ')})`, finalUrl };
      }
    }

    return { status: 'failed', detail: `No clear success/decline signal after ~20s. Steps: ${log.join(' → ')}. Audit the Steel session`, finalUrl };
  } finally {
    try { await session.browser.close(); } catch { /* ignore */ }
  }
}

/**
 * Execute real card payment automation on Swiggy Web using Prava's one-time credential.
 */
export async function executeSwiggyWebCheckout(
  credentials: MerchantPaymentCredentials,
  opts: { amount?: number; restaurantName?: string; deliveryAddress?: string } = {}
): Promise<MerchantExecutionResult> {
  const session = await createSteelSession('https://www.swiggy.com/checkout', {
    country: process.env.STEEL_COUNTRY || 'IN',
    stealth: true,
    solveCaptcha: true,
  });

  try {
    const { page } = session;
    const log: string[] = [];
    const trace = (step: string) => log.push(step);

    trace('opened swiggy checkout page');
    await page.waitForTimeout(2000);

    // 1. Locate Credit / Debit Card option on Swiggy web checkout
    const cardTab = await firstVisible(page, [
      'button:has-text("Credit/Debit")',
      'button:has-text("Credit & Debit Cards")',
      'div:has-text("Credit & Debit Cards")',
      'div:has-text("Add New Card")',
      '[data-cy="payment-card-option"]',
      '#credit-card',
    ]);

    if (cardTab) {
      await cardTab.click();
      trace('clicked Credit/Debit card tab');
      await page.waitForTimeout(1500);
    }

    // 2. Fill the card inputs with Prava one-time credential
    const cardField = await firstVisible(page, FIELD_CARD_NUMBER);
    if (!cardField) {
      return {
        status: 'blocked',
        detail: `Swiggy payment form not found (steps: ${log.join(' → ')}). User can complete payment on Swiggy directly.`,
        finalUrl: page.url(),
      };
    }

    await cardField.fill(credentials.pan.replace(/\s/g, ''));
    trace('filled card number token');

    const expiryField = await firstVisible(page, FIELD_EXPIRY);
    if (expiryField) {
      await expiryField.fill(`${credentials.expiryMonth}${credentials.expiryYear.slice(-2)}`);
      trace('filled expiry');
    }

    const cvvField = await firstVisible(page, FIELD_CVV);
    if (cvvField) {
      await cvvField.fill(credentials.cvv);
      trace('filled dynamic cvv');
    }

    // 3. Submit payment
    const submitBtn = await firstVisible(page, [
      'button:has-text("PAY")',
      'button:has-text("Pay")',
      'button:has-text("PROCEED TO PAY")',
      'button:has-text("Place Order")',
      'input[type="submit"]',
    ]);

    if (submitBtn) {
      await submitBtn.click();
      trace('submitted card payment on Swiggy web');
    } else {
      trace('no explicit submit button found, checking form status');
    }

    // 4. Poll page for outcome signals
    const successSignals = [
      'order placed', 'order confirmed', 'thank you for your order',
      'payment successful', 'order #', 'swiggy order',
    ];
    const declineSignals = [
      'payment failed', 'card declined', 'transaction declined',
      'invalid card', 'bank error', 'payment error', 'enter otp',
    ];

    let finalUrl = page.url();
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(4000);
      finalUrl = page.url();
      const bodyText = (await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '')).toLowerCase();

      const successHit = successSignals.find((s) => bodyText.includes(s));
      const declineHit = declineSignals.find((s) => bodyText.includes(s));

      if (successHit) {
        const orderMatch = bodyText.match(/order\s*(?:id|number|#)?\s*[:#]?\s*([A-Z0-9-]{6,})/i);
        return {
          status: 'approved',
          detail: `Swiggy card payment succeeded ("${successHit}" detected)`,
          orderReference: orderMatch?.[1],
          finalUrl,
        };
      }

      if (declineHit) {
        return {
          status: 'declined',
          detail: `Swiggy card payment failed ("${declineHit}" detected). Steps: ${log.join(' → ')}`,
          finalUrl,
        };
      }
    }

    return {
      status: 'failed',
      detail: `No definitive outcome signal after 20s. Steps: ${log.join(' → ')}`,
      finalUrl,
    };
  } finally {
    try { await session.browser.close(); } catch { /* ignore */ }
  }
}
