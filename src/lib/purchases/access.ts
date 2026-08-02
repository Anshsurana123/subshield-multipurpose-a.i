import 'server-only';

import { getSupabaseAdmin } from '@/lib/supabase/server';

export async function userOwnsPravaSession(userId: string, sessionId: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from('payment_sessions')
    .select('purchase_orders!inner(user_id)')
    .eq('provider', 'prava')
    .eq('provider_session_id', sessionId)
    .eq('purchase_orders.user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Payment session ownership lookup failed: ${error.code}`);
  return Boolean(data);
}
