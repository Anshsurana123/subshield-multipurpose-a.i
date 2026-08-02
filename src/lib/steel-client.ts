import Steel from 'steel-sdk';
import { chromium, Browser, Page } from 'playwright-core';
import { requirePublicHttpsUrl } from './security/url';

export interface SteelSessionResult {
  client: Steel;
  session: Steel.Session;
  browser: Browser;
  page: Page;
  sessionUrl: string;
}

export interface SteelSessionOptions {
  /** Optional proxy URL (e.g. http://user:pass@host:port). Overrides STEEL_PROXY_URL. */
  proxy?: string;
  /** Country for egress proxy geolocation (e.g. "IN", "US", "DE"). */
  country?: string;
  /** Enable stealth mode to reduce bot detection. Default: true when STEEL_STEALTH=1 */
  stealth?: boolean;
  /** Attempt automatic CAPTCHA solving. Default: true when STEEL_SOLVE_CAPTCHA=1 */
  solveCaptcha?: boolean;
  /** Custom user agent. */
  userAgent?: string;
  viewport?: { width: number; height: number };
  /**
   * Pre-authenticated cookies to inject into the browser context BEFORE
   * navigation. Array of Playwright-format cookie objects. Used to bypass
   * login walls (e.g. Amazon session cookies from AMAZON_SESSION_COOKIES env).
   */
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  }>;
}

/**
 * Create a Steel Cloud Browser session with optional proxy/stealth/captcha
 * configuration. Reads defaults from env so behavior can be tuned per deploy:
 *   STEEL_PROXY_URL, STEEL_COUNTRY, STEEL_STEALTH=1, STEEL_SOLVE_CAPTCHA=1
 */
export async function createSteelSession(
  initialUrl?: string,
  options: SteelSessionOptions = {}
): Promise<SteelSessionResult> {
  const steelAPIKey = process.env.STEEL_API_KEY;
  if (!steelAPIKey) {
    throw new Error('STEEL_API_KEY is missing from environment variables.');
  }

  const client = new Steel({ steelAPIKey });

  const sessionParams: Steel.SessionCreateParams = {
    ...(options.proxy || process.env.STEEL_PROXY_URL
      ? { proxyUrl: options.proxy || process.env.STEEL_PROXY_URL }
      : {}),
    ...(options.country || process.env.STEEL_COUNTRY
      ? {
          useProxy: {
            geolocation: {
              country: (options.country || process.env.STEEL_COUNTRY || 'US').toUpperCase() as any,
            },
          },
        }
      : {}),
    ...(options.stealth ?? process.env.STEEL_STEALTH === '1'
      ? {
          stealthConfig: {
            humanizeInteractions: true,
            ...(options.solveCaptcha ?? process.env.STEEL_SOLVE_CAPTCHA === '1'
              ? { autoCaptchaSolving: true }
              : {}),
          },
        }
      : options.solveCaptcha ?? process.env.STEEL_SOLVE_CAPTCHA === '1'
        ? { solveCaptcha: true }
        : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.viewport ? { dimensions: options.viewport } : {}),
  };

  let session: Steel.Session;
  try {
    session = await client.sessions.create(sessionParams);
  } catch (err: any) {
    if (
      err?.status === 403 ||
      (err?.message && String(err.message).includes('10 in paid balance'))
    ) {
      console.warn(
        '[Steel Client] Steel API requires $10 paid balance for built-in proxies/CAPTCHA solving. Retrying session without built-in proxies/CAPTCHA...'
      );
      const fallbackParams: Steel.SessionCreateParams = {
        ...(options.proxy || process.env.STEEL_PROXY_URL
          ? { proxyUrl: options.proxy || process.env.STEEL_PROXY_URL }
          : {}),
        ...(options.stealth ?? process.env.STEEL_STEALTH === '1'
          ? { stealthConfig: { humanizeInteractions: true } }
          : {}),
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        ...(options.viewport ? { dimensions: options.viewport } : {}),
      };
      session = await client.sessions.create(fallbackParams);
    } else {
      throw err;
    }
  }

  let browser: Browser | null = null;
  try {
    const cdpUrl = `wss://connect.steel.dev?apiKey=${steelAPIKey}&sessionId=${session.id}`;
    browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Steel session connected without a browser context.');
    const page = context.pages()[0] ?? (await context.newPage());

    // Inject pre-authenticated cookies before navigating (login bypass).
    if (options.cookies?.length) {
      await context.addCookies(options.cookies);
    }

    // Validate both the initial target and every main-frame redirect before the
    // cloud browser follows it. Subresources remain usable, while redirects to
    // loopback/private networks are aborted.
    if (initialUrl) await requirePublicHttpsUrl(initialUrl);
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) {
        await route.continue();
        return;
      }
      try {
        await requirePublicHttpsUrl(request.url());
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });

    const target = initialUrl || 'about:blank';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

    return {
      client,
      session,
      browser,
      page,
      sessionUrl: session.debugUrl,
    };
  } catch (error) {
    try { await browser?.close(); } catch { /* ignore cleanup errors */ }
    try { await client.sessions.release(session.id); } catch { /* ignore cleanup errors */ }
    throw error;
  }
}

/** Close the CDP connection and release the remote Steel session. */
export async function releaseSteelSession(session: SteelSessionResult): Promise<void> {
  try {
    await session.browser.close();
  } catch {
    // The remote session release below is still required if the CDP connection
    // has already gone away.
  } finally {
    try { await session.client.sessions.release(session.session.id); } catch { /* ignore cleanup errors */ }
  }
}
