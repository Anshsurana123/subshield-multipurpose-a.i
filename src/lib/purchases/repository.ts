import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { assertPurchaseTransition } from './state-machine';
import type { PurchaseOrderRecord, PurchaseState } from './types';

export interface PurchaseItemRecord {
  id: string;
  purchase_order_id: string;
  requested_name: string;
  merchant_product_id: string | null;
  merchant_variant_id: string | null;
  resolved_name: string | null;
  unit_price_minor: number | string | null;
  quantity: number;
  availability_status: string | null;
}

export type PaymentSessionStatus =
  | 'pending'
  | 'processing'
  | 'awaiting_result'
  | 'completed'
  | 'failed'
  | 'revoked';

const PAYMENT_SESSION_TRANSITIONS: Readonly<Record<PaymentSessionStatus, readonly PaymentSessionStatus[]>> = {
  pending: ['processing', 'awaiting_result', 'failed', 'revoked'],
  processing: ['awaiting_result', 'completed', 'failed', 'revoked'],
  awaiting_result: ['processing', 'failed', 'revoked'],
  completed: [],
  failed: [],
  revoked: [],
};

export interface PurchaseWithItems extends PurchaseOrderRecord {
  purchase_items: PurchaseItemRecord[];
}

export interface TransitionResult {
  applied: boolean;
  order: PurchaseOrderRecord;
}

const MUTABLE_TRANSITION_FIELDS = new Set([
  'quoted_total_minor',
  'authorized_total_minor',
  'merchant_total_minor',
  'selected_address_id',
  'external_order_ref',
  'merchant_order_id',
  'merchant_order_url',
  'expires_at',
]);

function sanitizeTransitionPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!MUTABLE_TRANSITION_FIELDS.has(key)) {
      throw new Error(`Purchase transition cannot update ${key}`);
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export class PurchaseRepository {
  constructor(private readonly client: SupabaseClient = getSupabaseAdmin()) {}

  async getForUser(id: string, userId: string): Promise<PurchaseWithItems | null> {
    const { data, error } = await this.client
      .from('purchase_orders')
      .select('*, purchase_items(*)')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Purchase read failed: ${error.code}`);
    return data as PurchaseWithItems | null;
  }

  async getById(id: string): Promise<PurchaseOrderRecord | null> {
    const { data, error } = await this.client
      .from('purchase_orders')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`Purchase read failed: ${error.code}`);
    return data as PurchaseOrderRecord | null;
  }

  async transition(input: {
    id: string;
    userId?: string;
    from: PurchaseState;
    to: PurchaseState;
    expectedVersion: number;
    patch?: Record<string, unknown>;
  }): Promise<TransitionResult> {
    assertPurchaseTransition(input.from, input.to);
    const update = {
      ...sanitizeTransitionPatch(input.patch || {}),
      state: input.to,
      version: input.expectedVersion + 1,
      updated_at: new Date().toISOString(),
    };

    let query = this.client
      .from('purchase_orders')
      .update(update)
      .eq('id', input.id)
      .eq('state', input.from)
      .eq('version', input.expectedVersion);
    if (input.userId) query = query.eq('user_id', input.userId);

    const { data, error } = await query.select('*').maybeSingle();
    if (error) throw new Error(`Purchase transition failed: ${error.code}`);
    if (data) return { applied: true, order: data as PurchaseOrderRecord };

    const current = input.userId
      ? await this.getForUser(input.id, input.userId)
      : await this.getById(input.id);
    if (!current) throw new Error('Purchase order not found');
    return { applied: false, order: current };
  }

  async createPaymentSession(input: {
    purchaseOrderId: string;
    providerSessionId: string;
    providerOrderId: string | null;
    expiresAt: string;
    amountMinor: bigint;
    currency: string;
  }): Promise<void> {
    const { error } = await this.client.from('payment_sessions').insert({
      purchase_order_id: input.purchaseOrderId,
      provider: 'prava',
      provider_session_id: input.providerSessionId,
      provider_order_id: input.providerOrderId,
      status: 'pending',
      expires_at: input.expiresAt,
      amount_minor: input.amountMinor.toString(),
      currency: input.currency,
    });
    if (error) throw new Error(`Payment session persistence failed: ${error.code}`);
  }

  async transitionPaymentSession(input: {
    providerSessionId: string;
    from: PaymentSessionStatus;
    to: PaymentSessionStatus;
  }): Promise<boolean> {
    if (!PAYMENT_SESSION_TRANSITIONS[input.from].includes(input.to)) {
      throw new Error(`Invalid payment session transition: ${input.from} -> ${input.to}`);
    }
    const patch: Record<string, unknown> = { status: input.to, updated_at: new Date().toISOString() };
    if (input.to === 'awaiting_result') patch.credential_issued_at = new Date().toISOString();
    if (input.to === 'completed') patch.reported_at = new Date().toISOString();

    const { data, error } = await this.client
      .from('payment_sessions')
      .update(patch)
      .eq('provider', 'prava')
      .eq('provider_session_id', input.providerSessionId)
      .eq('status', input.from)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Payment session update failed: ${error.code}`);
    return Boolean(data);
  }

  async purchaseForPaymentSession(providerSessionId: string): Promise<PurchaseOrderRecord | null> {
    const { data, error } = await this.client
      .from('payment_sessions')
      .select('purchase_orders(*)')
      .eq('provider', 'prava')
      .eq('provider_session_id', providerSessionId)
      .maybeSingle();
    if (error) throw new Error(`Payment purchase lookup failed: ${error.code}`);
    const purchase = (data as any)?.purchase_orders;
    return (Array.isArray(purchase) ? purchase[0] : purchase) || null;
  }

  async claimExecution(input: {
    purchaseOrderId: string;
    expectedVersion: number;
    attemptId?: string;
  }): Promise<{ claimed: boolean; attemptId: string | null; orderVersion: number | null }> {
    const { data, error } = await this.client.rpc('claim_purchase_execution', {
      p_purchase_order_id: input.purchaseOrderId,
      p_expected_version: input.expectedVersion,
      p_attempt_id: input.attemptId || crypto.randomUUID(),
    });
    if (error) throw new Error(`Execution claim failed: ${error.code}`);
    const row = Array.isArray(data) ? data[0] : data;
    return {
      claimed: Boolean(row?.claimed),
      attemptId: row?.checkout_attempt_id || null,
      orderVersion: row?.purchase_version == null ? null : Number(row.purchase_version),
    };
  }

  async requestPravaSession(input: {
    purchaseOrderId: string;
    userId: string;
    expectedVersion: number;
  }): Promise<{ accepted: boolean; jobId: string | null; orderVersion: number | null }> {
    const { data, error } = await this.client.rpc('request_prava_session', {
      p_purchase_order_id: input.purchaseOrderId,
      p_user_id: input.userId,
      p_expected_version: input.expectedVersion,
    });
    if (error) throw new Error(`Prava session request failed: ${error.code}`);
    const row = Array.isArray(data) ? data[0] : data;
    return {
      accepted: Boolean(row?.accepted),
      jobId: row?.workflow_job_id || null,
      orderVersion: row?.purchase_version == null ? null : Number(row.purchase_version),
    };
  }
}

export function getPurchaseRepository(): PurchaseRepository {
  return new PurchaseRepository();
}
