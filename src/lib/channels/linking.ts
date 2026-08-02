import 'server-only';

import { createHash, randomBytes } from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { ChannelProvider } from './repository';

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function extractChannelLinkCode(text: string): string | null {
  const match = text.trim().match(/^\/link(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{22})$/i);
  return match?.[1] ?? null;
}

export async function createChannelLinkRequest(userId: string, provider: ChannelProvider): Promise<{
  code: string;
  expiresAt: string;
}> {
  const admin = getSupabaseAdmin();
  const { error: deleteError } = await admin
    .from('channel_link_requests')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider)
    .is('consumed_at', null);
  if (deleteError) throw new Error(`Channel link cleanup failed: ${deleteError.code}`);

  const code = randomBytes(16).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const { error } = await admin.from('channel_link_requests').insert({
    user_id: userId,
    provider,
    code_hash: hashCode(code),
    expires_at: expiresAt,
  });
  if (error) throw new Error(`Channel link request failed: ${error.code}`);
  return { code, expiresAt };
}

export async function consumeChannelLinkCommand(input: {
  provider: ChannelProvider;
  eventId: string;
  code: string;
  providerUserId: string;
  chatId: string;
}): Promise<{ linked: boolean; duplicate: boolean }> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(input.code)) return { linked: false, duplicate: false };
  const { data, error } = await getSupabaseAdmin().rpc('consume_channel_link', {
    p_provider: input.provider,
    p_event_id: input.eventId,
    p_code_hash: hashCode(input.code),
    p_provider_user_id: input.providerUserId,
    p_chat_id: input.chatId,
  });
  if (error) throw new Error(`Channel link verification failed: ${error.code}`);
  const row = Array.isArray(data) ? data[0] : data;
  return { linked: Boolean(row?.linked), duplicate: Boolean(row?.duplicate) };
}

export async function listLinkedChannels(userId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from('channel_identities')
    .select('provider, verified_at')
    .eq('user_id', userId)
    .order('provider');
  if (error) throw new Error(`Channel link read failed: ${error.code}`);
  return data || [];
}

export async function unlinkChannel(userId: string, provider: ChannelProvider): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('channel_identities')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw new Error(`Channel unlink failed: ${error.code}`);
}
