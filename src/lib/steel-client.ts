import Steel from 'steel-sdk';
import { chromium, Browser, Page } from 'playwright-core';

export interface SteelSessionResult {
  client: Steel;
  session: any;
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
  console.log('[SteelClient] Creating Steel cloud browser session...');

  const sessionParams: any = {
    // Stealth + captcha solving are the two knobs that make price scraping
    // and checkout work on bot-protected sites (Amazon.in, Flipkart, etc).
    ...(options.proxy || process.env.STEEL_PROXY_URL
      ? { proxy: options.proxy || process.env.STEEL_PROXY_URL }
      : {}),
    ...(options.country || process.env.STEEL_COUNTRY
      ? { country: options.country || process.env.STEEL_COUNTRY }
      : {}),
    ...(options.stealth ?? process.env.STEEL_STEALTH === '1'
      ? { stealth: true }
      : {}),
    ...(options.solveCaptcha ?? process.env.STEEL_SOLVE_CAPTCHA === '1'
      ? { solveCaptcha: true }
      : {}),
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    ...(options.viewport ? { viewport: options.viewport } : {}),
  };

  const session = await client.sessions.create(sessionParams);
  console.log(`[SteelClient] Created Steel session: ${session.id}${Object.keys(sessionParams).length ? ` (options: ${JSON.stringify(sessionParams)})` : ''}`);

  const cdpUrl = `wss://connect.steel.dev?apiKey=${steelAPIKey}&sessionId=${session.id}`;
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());

  // Inject pre-authenticated cookies before navigating (login bypass).
  if (options.cookies?.length) {
    await context.addCookies(options.cookies);
    console.log(`[SteelClient] Injected ${options.cookies.length} cookies into session.`);
  }

  const target = initialUrl || 'https://accounts.google.com/ServiceLogin';
  console.log(`[SteelClient] Navigating session to ${target}...`);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const sessionUrl = `https://app.steel.dev/sessions/${session.id}`;

  return {
    client,
    session,
    browser,
    page,
    sessionUrl,
  };
}
