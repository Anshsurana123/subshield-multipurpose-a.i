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
  headers: Headers
): boolean {
  const secret = process.env.LINQ_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[LinqClient] LINQ_WEBHOOK_SECRET not configured — skipping signature verification.');
    return true;
  }

  // 1. Official Linq v3 Webhook Signature Verification (Standard Webhook / Svix style)
  // Headers: webhook-id, webhook-timestamp, webhook-signature
  const msgId = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const webhookSignature = headers.get('webhook-signature');

  if (msgId && timestamp && webhookSignature) {
    try {
      const secretStr = secret.startsWith('whsec_') ? secret.slice(6) : secret;
      const keyBytes = Buffer.from(secretStr, 'base64');
      const signedContent = `${msgId}.${timestamp}.${rawBody}`;
      const expectedBase64 = createHmac('sha256', keyBytes)
        .update(signedContent)
        .digest('base64');

      const isValid = webhookSignature.split(' ').some((sig) => {
        if (!sig.startsWith('v1,')) return false;
        try {
          const sigBuf = Buffer.from(sig.slice(3), 'base64');
          const expectedBuf = Buffer.from(expectedBase64, 'base64');
          return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
        } catch {
          return false;
        }
      });

      if (isValid) return true;
    } catch (err) {
      console.warn('[LinqClient] Standard webhook signature check exception:', err);
    }
  }

  // 2. Fallback candidate header check (hex HMAC)
  const candidates = [
    headers.get('x-webhook-signature'),
    headers.get('x-linq-signature'),
    headers.get('x-signature'),
    headers.get('linq-signature'),
  ].filter((v): v is string => !!v);

  if (candidates.length === 0 && !webhookSignature) {
    console.warn('[LinqClient] No signature header found on Linq webhook.');
    return false;
  }

  const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest();

  for (const provided of candidates) {
    const providedBuf = Buffer.from(provided.replace(/^sha256=/, ''), 'hex');
    if (providedBuf.length === expectedHex.length && timingSafeEqual(providedBuf, expectedHex)) {
      return true;
    }
  }

  console.warn('[LinqClient] Linq webhook signature verification FAILED.');
  return false;
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
