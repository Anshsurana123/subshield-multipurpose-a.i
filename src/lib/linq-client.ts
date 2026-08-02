import { createHmac, timingSafeEqual } from 'crypto';

const LINQ_API_BASE = 'https://api.linqapp.com/api/partner/v3';

/**
 * Verify that an incoming Linq webhook is authentic.
 * Linq signs webhook bodies with HMAC-SHA256 using the secret returned when the
 * webhook subscription was created. We check several common header names since
 * the SDK/dashboard may send `X-Linq-Signature` or `X-Signature`.
 */
export function verifyLinqWebhookSignature(
  rawBody: string,
  headers: Headers,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  const secret = process.env.LINQ_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return false;
  }

  const msgId = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const webhookSignature = headers.get('webhook-signature');
  if (!msgId || !timestamp || !webhookSignature) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) {
    return false;
  }

  try {
    const secretStr = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const keyBytes = Buffer.from(secretStr, 'base64');
    if (keyBytes.length < 16) return false;

    const expected = createHmac('sha256', keyBytes)
      .update(`${msgId}.${timestamp}.${rawBody}`)
      .digest();

    return webhookSignature.split(' ').some((signature) => {
      if (!signature.startsWith('v1,')) return false;
      const provided = Buffer.from(signature.slice(3), 'base64');
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    });
  } catch {
    return false;
  }
}

export interface LinqWebhookSubscription {
  id: string;
  is_active?: boolean;
  target_url: string;
  subscribed_events: string[];
  signing_secret?: string; // only returned at creation time — store it immediately
}

/**
 * Register (or update) a webhook subscription on Linq so inbound messages are
 * delivered to our server. The response contains `signing_secret` ONLY at
 * creation time — the caller MUST persist it (e.g. LINQ_WEBHOOK_SECRET in env).
 */
export async function registerLinqWebhook(
  targetUrl: string,
  events: string[] = ['message.received', 'message.delivered']
): Promise<{ ok: boolean; subscription?: LinqWebhookSubscription; error?: string }> {
  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey) {
    console.error('[LinqClient] LINQ_API_KEY missing — cannot register webhook.');
    return { ok: false, error: 'LINQ_API_KEY missing' };
  }

  try {
    const res = await fetch(`${LINQ_API_BASE}/webhook-subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        target_url: targetUrl,
        subscribed_events: events,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[LinqClient] register webhook failed (${res.status}): ${errText}`);
      return { ok: false, error: `HTTP ${res.status}: ${errText}` };
    }

    const data = (await res.json()) as LinqWebhookSubscription;
    // Never log the signing_secret — it's shown only once and must stay private.
    const { signing_secret: _secret, ...safe } = data;
    console.log('[LinqClient] Webhook subscription registered:', JSON.stringify(safe));
    return { ok: true, subscription: data };
  } catch (err) {
    console.error('[LinqClient] register webhook error:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List existing webhook subscriptions (does NOT include signing_secret).
 */
export async function listLinqWebhooks(): Promise<LinqWebhookSubscription[]> {
  const apiKey = process.env.LINQ_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch(`${LINQ_API_BASE}/webhook-subscriptions`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.subscriptions || [];
  } catch {
    return [];
  }
}
