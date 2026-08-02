import 'server-only';

import { getSupabaseAdmin } from '@/lib/supabase/server';

export type ChannelProvider = 'telegram' | 'linq';

export interface LinkedChannelIdentity {
  userId: string;
  provider: ChannelProvider;
  providerUserId: string;
  chatId: string;
}

const SENSITIVE_PAYMENT_MESSAGE = '__PAYMENT_DATA_REDACTED__';

export function sanitizeInboundChannelText(text: string): string {
  const normalized = text.trim().slice(0, 8_000);
  const looksLikePan = /\b(?:\d[ -]?){13,19}\b/.test(normalized);
  const namesSecurityCode = /\b(?:cvv|cvc|security\s+code)\s*[:=-]?\s*\d{3,4}\b/i.test(normalized);
  if (looksLikePan || namesSecurityCode) return SENSITIVE_PAYMENT_MESSAGE;
  return normalized;
}

export function isSensitivePaymentSentinel(text: string): boolean {
  return text === SENSITIVE_PAYMENT_MESSAGE;
}

export async function resolveChannelIdentity(
  provider: ChannelProvider,
  providerUserId: string,
  chatId: string
): Promise<LinkedChannelIdentity | null> {
  const { data, error } = await getSupabaseAdmin()
    .from('channel_identities')
    .select('user_id, provider, provider_user_id, provider_chat_id')
    .eq('provider', provider)
    .eq('provider_user_id', providerUserId)
    .eq('provider_chat_id', chatId)
    .not('verified_at', 'is', null)
    .maybeSingle();

  if (error) throw new Error(`Channel identity lookup failed: ${error.code}`);
  if (!data) return null;

  return {
    userId: data.user_id,
    provider: data.provider as ChannelProvider,
    providerUserId: data.provider_user_id,
    chatId: data.provider_chat_id,
  };
}

/** Verify ownership, deduplicate, and enqueue in one database transaction. */
export async function claimAndEnqueueChannelEvent(input: {
  provider: ChannelProvider;
  eventId: string;
  userId: string;
  providerUserId: string;
  chatId: string;
  text: string;
}): Promise<{ claimed: boolean; jobId: string | null }> {
  const { data, error } = await getSupabaseAdmin().rpc('claim_and_enqueue_channel_event', {
    p_provider: input.provider,
    p_event_id: input.eventId,
    p_user_id: input.userId,
    p_provider_user_id: input.providerUserId,
    p_chat_id: input.chatId,
    p_text: sanitizeInboundChannelText(input.text),
  });
  if (error) throw new Error(`Channel event enqueue failed: ${error.code}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    claimed: Boolean(row?.claimed),
    jobId: typeof row?.workflow_job_id === 'string' ? row.workflow_job_id : null,
  };
}
