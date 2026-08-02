import 'server-only';

import { getSupabaseAdmin } from '@/lib/supabase/server';

export type SupportedWorkflowJobType =
  | 'process_channel_message'
  | 'send_tracker_chat_alert'
  | 'send_push_notification'
  | 'send_channel_link_confirmation';

export interface ClaimedWorkflowJob {
  id: string;
  purchaseOrderId: string | null;
  jobType: SupportedWorkflowJobType;
  payload: Record<string, unknown>;
  attemptCount: number;
  leaseToken: string;
}

export async function claimWorkflowJob(): Promise<ClaimedWorkflowJob | null> {
  const { data, error } = await getSupabaseAdmin().rpc('claim_workflow_job', {
    p_job_types: [
      'process_channel_message',
      'send_tracker_chat_alert',
      'send_push_notification',
      'send_channel_link_confirmation',
    ],
    p_lease_seconds: 300,
  });
  if (error) throw new Error(`Workflow claim failed: ${error.code}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  if (![
    'process_channel_message',
    'send_tracker_chat_alert',
    'send_push_notification',
    'send_channel_link_confirmation',
  ].includes(row.job_type)) {
    throw new Error('Unsupported workflow job type');
  }
  return {
    id: row.id,
    purchaseOrderId: row.purchase_order_id || null,
    jobType: row.job_type,
    payload: row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {},
    attemptCount: Number(row.attempt_count),
    leaseToken: row.lease_token,
  };
}

export async function finishWorkflowJob(input: {
  id: string;
  leaseToken: string;
  succeeded: boolean;
  retryable: boolean;
  errorCode?: string;
}): Promise<void> {
  const { data, error } = await getSupabaseAdmin().rpc('finish_workflow_job', {
    p_job_id: input.id,
    p_lease_token: input.leaseToken,
    p_succeeded: input.succeeded,
    p_retryable: input.retryable,
    p_error_code: input.errorCode || null,
  });
  if (error) throw new Error(`Workflow completion failed: ${error.code}`);
  if (data !== true) throw new Error('Workflow lease was not active');
}
