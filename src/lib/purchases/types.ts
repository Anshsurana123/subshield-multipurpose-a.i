export const PURCHASE_STATES = [
  'draft',
  'resolving',
  'awaiting_cart_review',
  'cart_confirmed',
  'quoting',
  'awaiting_quote_confirmation',
  'quoted',
  'awaiting_payment_approval',
  'credential_ready',
  'executing',
  'submitted',
  'unknown_reconciliation',
  'completed',
  'declined',
  'failed',
  'canceled',
  'expired',
] as const;

export type PurchaseState = (typeof PURCHASE_STATES)[number];
export type PurchaseCategory = 'food' | 'grocery' | 'product';
export type MerchantProvider = 'swiggy' | 'zepto' | 'shopify';
export type SourceChannel = 'telegram' | 'linq' | 'web';

export interface PurchaseOrderRecord {
  id: string;
  user_id: string;
  source_channel: SourceChannel;
  source_event_id: string | null;
  source_chat_id: string | null;
  category: PurchaseCategory;
  merchant_provider: MerchantProvider;
  merchant_name: string;
  merchant_domain: string;
  merchant_account_id: string | null;
  merchant_country_code: string | null;
  merchant_category_code: string | null;
  merchant_category: string | null;
  state: PurchaseState;
  currency: string;
  quoted_total_minor: number | string | null;
  authorized_total_minor: number | string | null;
  merchant_total_minor: number | string | null;
  selected_address_id: string | null;
  external_order_ref: string | null;
  merchant_order_id: string | null;
  merchant_order_url: string | null;
  idempotency_key: string;
  version: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type MerchantOutcome =
  | { status: 'approved'; orderId: string; orderUrl: string; amountMinor: number }
  | { status: 'declined'; processorResponseCode?: string }
  | { status: 'requires_action'; continueUrl?: string }
  | { status: 'unknown'; reasonCode: string };
