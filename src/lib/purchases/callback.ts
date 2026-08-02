import 'server-only';

import { createHash, randomBytes } from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabase/server';

export function hashCallbackState(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function appOrigin(): URL {
  const value = process.env.APP_BASE_URL?.trim();
  if (!value) throw new Error('APP_BASE_URL is required');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new Error('APP_BASE_URL must be an HTTPS origin');
  }
  return url;
}

export async function createPravaCallbackState(purchaseOrderId: string): Promise<{
  token: string;
  callbackUrl: string;
  expiresAt: string;
}> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const { error } = await getSupabaseAdmin().from('payment_callback_states').upsert({
    purchase_order_id: purchaseOrderId,
    token_hash: hashCallbackState(token),
    expires_at: expiresAt,
    consumed_at: null,
  }, { onConflict: 'purchase_order_id' });
  if (error) throw new Error(`Callback state persistence failed: ${error.code}`);

  const callbackUrl = new URL('/api/prava/callback', appOrigin());
  callbackUrl.searchParams.set('state', token);
  return { token, callbackUrl: callbackUrl.toString(), expiresAt };
}

export async function consumePravaCallbackState(token: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const { data, error } = await getSupabaseAdmin().rpc('consume_prava_callback', {
    p_token_hash: hashCallbackState(token),
  });
  if (error) throw new Error(`Callback state consumption failed: ${error.code}`);
  const row = Array.isArray(data) ? data[0] : data;
  return Boolean(row?.consumed);
}
