import { createSteelSession, releaseSteelSession } from './steel-client';

export interface ScrapedProductPrice {
  price: number | null;
  title: string | null;
  currency: string;
}

/**
 * Scrape a live price for a product URL using a real Steel Cloud Browser session.
 *
 * Strategy (in order of reliability):
 *  1. JSON-LD structured data (`application/ld+json` → offers.price / lowPrice)
 *  2. OpenGraph / product meta tags (og:price:amount, product:price:amount)
 *  3. Common price selectors (itemprop="price", .price, [data-testid="price"])
 *  4. Regex fallback over visible text ($1,299.99 pattern)
 *
 * Returns `price: null` when the price cannot be determined — the caller must
 * NOT trigger a purchase in that case (fail-safe).
 */
export async function scrapeLivePrice(productUrl: string): Promise<ScrapedProductPrice> {
  if (!process.env.STEEL_API_KEY) {
    return { price: null, title: null, currency: 'USD' };
  }

  const session = await createSteelSession(productUrl);
  try {
    // Give JS-rendered shops a moment to hydrate the price element.
    try {
      await session.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      await session.page.waitForTimeout(2500);
    } catch { /* load state race is non-fatal */ }

    const extracted = await session.page.evaluate(() => {
      const result: { price: number | null; title: string | null; currency: string } = {
        price: null,
        title: document.title || null,
        currency: 'USD',
      };

      const toNumber = (v: string | null | undefined): number | null => {
        if (!v) return null;
        const cleaned = v.replace(/[,\s]/g, '');
        const match = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
        if (!match) return null;
        const n = parseFloat(match[1]);
        return isNaN(n) || n <= 0 ? null : n;
      };

      // 1. JSON-LD structured data
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent || '');
          const nodes = Array.isArray(data) ? data : [data];
          for (const node of nodes) {
            const offers = node?.offers || node?.mainEntity?.offers;
            const offerList = Array.isArray(offers) ? offers : offers ? [offers] : [];
            for (const offer of offerList) {
              const price = toNumber(String(offer?.price ?? ''));
              if (price !== null) {
                result.price = price;
                result.currency = offer?.priceCurrency || node?.priceCurrency || 'USD';
                return result;
              }
            }
          }
        } catch { /* skip malformed JSON-LD */ }
      }

      // 2. Meta tags
      const metaSelectors = [
        'meta[property="og:price:amount"]',
        'meta[property="product:price:amount"]',
        'meta[name="twitter:data1"]',
        'meta[itemprop="price"]',
      ];
      for (const sel of metaSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const price = toNumber(el.getAttribute('content') || el.textContent);
          if (price !== null) {
            result.price = price;
            const currencyEl = document.querySelector('meta[property="og:price:currency"], meta[itemprop="priceCurrency"]');
            result.currency = currencyEl?.getAttribute('content') || 'USD';
            return result;
          }
        }
      }

      // 3. Amazon-specific: split whole/fraction price structure
      const amazonWhole = document.querySelector('.a-price .a-price-whole');
      const amazonFraction = document.querySelector('.a-price .a-price-fraction');
      if (amazonWhole) {
        const whole = (amazonWhole.textContent || '').replace(/[^\d]/g, '');
        const fraction = (amazonFraction?.textContent || '00').replace(/[^\d]/g, '').padEnd(2, '0').slice(0, 2);
        const price = parseFloat(`${whole}.${fraction}`);
        if (!isNaN(price) && price > 0) {
          result.price = price;
          result.currency = document.querySelector('.a-price-symbol')?.textContent?.includes('₹')
            ? 'INR'
            : result.currency;
          return result;
        }
      }

      // 4. Common selectors
      const priceSelectors = [
        '[itemprop="price"]',
        '[data-testid="price"]',
        '.price',
        '.a-price .a-offscreen', // Amazon
        '#priceblock_ourprice',
        '.product-price',
        '[class*="price"][class*="sale"]',
      ];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const price = toNumber(el.getAttribute('content') || el.textContent);
          if (price !== null) {
            result.price = price;
            return result;
          }
        }
      }

      // 5. Regex fallback over visible text — skip "save $X", "shipping $X",
      //    "you save", "discount" phrasing that would capture the wrong value.
      const bodyText = document.body?.innerText || '';
      const pricePattern = /(?:US\$|\$|₹|€|£)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
      const skipContext = /(?:sav(?:e|ing)|discount|off|shipping|delivery|fee|cashback|coupon)/i;
      let m: RegExpExecArray | null;
      while ((m = pricePattern.exec(bodyText)) !== null) {
        // Check the 30 characters preceding the match for misleading context.
        const preceding = bodyText.slice(Math.max(0, m.index - 30), m.index);
        if (skipContext.test(preceding)) continue;
        const price = toNumber(m[1]);
        if (price !== null) {
          result.price = price;
          return result;
        }
      }

      return result;
    });

    return {
      price: extracted.price,
      title: extracted.title,
      currency: extracted.currency || 'USD',
    };
  } finally {
    await releaseSteelSession(session);
  }
}
