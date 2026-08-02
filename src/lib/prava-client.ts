import 'server-only';

import { PRAVA_API_BASE, PRAVA_SESSION_TTL_MINUTES } from './constants';
import type { PaymentResult, PravaSession, SavedCard } from './types';
import { assertMerchantExecutionEnabled, assertPurchasesEnabled } from './purchases/guard';
import { formatMinorAmount, parseDecimalToMinor } from './purchases/money';
import { getSupabaseAdmin } from './supabase/server';

const PRAVA_TIMEOUT_MS = 15_000;
const SUPPORTED_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};
const PAYMENT_STATUSES = new Set(['pending', 'processing', 'awaiting_result', 'completed', 'failed']);

export interface PravaPurchaseItem {
  description: string;
  unitPriceMinor: bigint;
  quantity: number;
  productId?: string;
}

export interface PravaMerchantDetails {
  name: string;
  url: string;
  countryCodeIso2: string;
  categoryCode: string;
  category: string;
}

export interface CreatePravaPurchaseSessionInput {
  userId: string;
  userEmail: string;
  totalMinor: bigint;
  currency: string;
  externalOrderRef: string;
  description: string;
  merchant: PravaMerchantDetails;
  items: PravaPurchaseItem[];
  callbackUrl?: string;
}

export interface PravaExecutionCredential {
  txnRefId: string;
  amount: string;
  token: string;
  dynamicCvv: string;
  expiryMonth: string;
  expiryYear: string;
}

export interface PravaReportResult {
  status: string;
  txnStatus: string;
  visaConfirmation: string;
  responseId: string | null;
  /** Compatibility aliases for the legacy, disabled orchestration code. */
  txn_status: string;
  visa_confirmation: string;
}

export class PravaApiError extends Error {
  constructor(readonly status: number, readonly providerCode: string | null, operation: string) {
    super(`Prava ${operation} failed (${status}${providerCode ? `, ${providerCode}` : ''})`);
    this.name = 'PravaApiError';
  }
}

interface PravaClientOptions {
  secretKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Prava returned an invalid response object');
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, maxLength = 4096): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Prava response is missing ${key}`);
  }
  return value;
}

function providerErrorCode(body: string): string | null {
  try {
    const parsed = asRecord(JSON.parse(body));
    const error = parsed.error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const code = (error as Record<string, unknown>).code;
      return typeof code === 'string' ? code.slice(0, 80) : null;
    }
  } catch {
    // Provider bodies are deliberately not surfaced to callers or logs.
  }
  return null;
}

function validateHttpsUrl(value: string, field: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${field} must be an HTTPS URL without credentials`);
  }
  return url.toString();
}

function currencyExponent(currency: string): number {
  const exponent = SUPPORTED_CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) {
    throw new Error(`Unsupported Prava currency: ${currency}`);
  }
  return exponent;
}

function validateCreateInput(input: CreatePravaPurchaseSessionInput): {
  currency: string;
  merchantUrl: string;
  callbackUrl?: string;
  exponent: number;
} {
  const currency = input.currency.toUpperCase();
  const exponent = currencyExponent(currency);
  if (input.totalMinor <= 0n) throw new Error('Prava total must be positive');
  if (!input.userId || input.userId.length > 255) throw new Error('Prava user ID is invalid');
  if (!/^\S+@\S+\.\S+$/.test(input.userEmail) || input.userEmail.length > 320) {
    throw new Error('Prava user email is invalid');
  }
  if (!input.externalOrderRef || input.externalOrderRef.length > 255) {
    throw new Error('externalOrderRef is required');
  }
  if (!input.description.trim() || input.description.length > 500) {
    throw new Error('Prava description is invalid');
  }
  if (!input.merchant.name.trim() || input.merchant.name.length > 200) {
    throw new Error('Destination merchant name is required');
  }
  if (!/^[A-Z]{2}$/.test(input.merchant.countryCodeIso2)) {
    throw new Error('Merchant country must be an ISO-2 code');
  }
  if (!/^\d{4}$/.test(input.merchant.categoryCode)) {
    throw new Error('A validated four-digit merchant category code is required');
  }
  if (!input.merchant.category.trim() || input.merchant.category.length > 100) {
    throw new Error('A validated merchant category is required');
  }
  if (input.items.length === 0) throw new Error('At least one real purchase item is required');

  let itemTotal = 0n;
  for (const item of input.items) {
    if (!item.description.trim() || item.description.length > 500) {
      throw new Error('Purchase item description is invalid');
    }
    if (item.unitPriceMinor < 0n || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error('Purchase item price or quantity is invalid');
    }
    if (item.productId && item.productId.length > 50) {
      throw new Error('Purchase item product ID is too long');
    }
    itemTotal += item.unitPriceMinor * BigInt(item.quantity);
  }
  if (itemTotal !== input.totalMinor) {
    throw new Error('Purchase line items do not equal the exact authorized total');
  }

  return {
    currency,
    exponent,
    merchantUrl: validateHttpsUrl(input.merchant.url, 'Merchant URL'),
    callbackUrl: input.callbackUrl ? validateHttpsUrl(input.callbackUrl, 'Callback URL') : undefined,
  };
}

export class PravaClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PravaClientOptions = {}) {
    this.secretKey = options.secretKey ?? process.env.MERCHANT_SECRET_KEY?.trim() ?? '';
    this.baseUrl = (options.baseUrl ?? PRAVA_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private assertConfiguration(): void {
    if (!this.secretKey || (!this.secretKey.startsWith('sk_test_') && !this.secretKey.startsWith('sk_live_'))) {
      throw new Error('MERCHANT_SECRET_KEY must be a server-side Prava test or live key');
    }
    const url = new URL(this.baseUrl);
    const isSandbox = url.protocol === 'https:' && url.hostname === 'sandbox.api.prava.space' && (url.pathname === '/' || url.pathname === '');
    const isProduction = url.protocol === 'https:' && url.hostname === 'api.prava.space' && (url.pathname === '/' || url.pathname === '');
    if (!isSandbox && !isProduction) {
      throw new Error('PRAVA_API_BASE must be an official Prava API origin');
    }
    if ((isSandbox && !this.secretKey.startsWith('sk_test_')) || (isProduction && !this.secretKey.startsWith('sk_live_'))) {
      throw new Error('Prava key type does not match the configured API host');
    }
  }

  private headers(): Record<string, string> {
    this.assertConfiguration();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.secretKey}`,
    };
  }

  private async request(path: string, init: RequestInit, operation: string): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(PRAVA_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!response.ok) {
      const body = await response.text();
      throw new PravaApiError(response.status, providerErrorCode(body), operation);
    }
    return response;
  }

  async createPurchaseSession(input: CreatePravaPurchaseSessionInput): Promise<PravaSession> {
    assertPurchasesEnabled('prava:create-session');
    const validated = validateCreateInput(input);
    const payload: Record<string, unknown> = {
      user_id: input.userId,
      user_email: input.userEmail,
      total_amount: formatMinorAmount(input.totalMinor, validated.exponent),
      currency: validated.currency,
      external_order_ref: input.externalOrderRef,
      description: input.description,
      purchase_context: [{
        merchant_details: {
          name: input.merchant.name,
          url: validated.merchantUrl,
          country_code_iso2: input.merchant.countryCodeIso2,
          category_code: input.merchant.categoryCode,
          category: input.merchant.category,
        },
        product_details: input.items.map((item) => ({
          description: item.description,
          unit_price: formatMinorAmount(item.unitPriceMinor, validated.exponent),
          quantity: item.quantity,
          ...(item.productId ? { product_id: item.productId } : {}),
        })),
        effective_until_minutes: PRAVA_SESSION_TTL_MINUTES,
      }],
      ...(validated.callbackUrl ? { callback_url: validated.callbackUrl } : {}),
    };

    const response = await this.request('/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, 'session creation');
    const data = asRecord(await response.json());
    const sessionId = requiredString(data, 'session_id', 255);
    const sessionToken = requiredString(data, 'session_token', 16_384);
    const iframeUrl = validateHttpsUrl(requiredString(data, 'iframe_url', 4096), 'Prava iframe URL');
    const iframeHost = new URL(iframeUrl).hostname;
    if (iframeHost !== 'collect.prava.space' && iframeHost !== 'sandbox.collect.prava.space') {
      throw new Error('Prava returned an untrusted iframe host');
    }
    const orderId = requiredString(data, 'order_id', 255);
    const expiresAt = requiredString(data, 'expires_at', 100);
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error('Prava returned an invalid session expiry');
    }

    return { sessionId, sessionToken, iframeUrl, orderId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Legacy estimate-based session creation is permanently disabled. */
  async createMandateSession(_params: {
    userId: string;
    userEmail: string;
    vendorName: string;
    vendorDomain: string;
    amount: number;
    currency: string;
    description: string;
    callbackUrl?: string;
  }): Promise<PravaSession> {
    throw new Error('Legacy estimate-based Prava sessions are disabled; use a durable exact quote');
  }

  private async rawPaymentResult(sessionId: string): Promise<Record<string, unknown>> {
    if (!/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Prava session ID');
    const response = await this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/payment-result?_t=${Date.now()}`,
      { method: 'GET' },
      'payment-result polling'
    );
    return asRecord(await response.json());
  }

  private mapPaymentResult(data: Record<string, unknown>, requestedSessionId: string): PaymentResult {
    const returnedSessionId = requiredString(data, 'session_id', 255);
    if (returnedSessionId !== requestedSessionId) {
      throw new Error('Prava returned a payment result for a different session');
    }
    const status = requiredString(data, 'status', 50).toLowerCase();
    if (!PAYMENT_STATUSES.has(status)) throw new Error('Prava returned an unknown payment status');
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    const firstTransaction = transactions.length > 0 && transactions[0] && typeof transactions[0] === 'object'
      ? transactions[0] as Record<string, unknown>
      : null;
    const rawItems = firstTransaction && Array.isArray(firstTransaction.line_items)
      ? firstTransaction.line_items
      : [];
    const lineItems = rawItems.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      const token = typeof item.token === 'string' ? item.token : '';
      return [{
        txnRefId: typeof item.txn_ref_id === 'string' ? item.txn_ref_id : '',
        merchantName: typeof item.merchant_name === 'string' ? item.merchant_name : '',
        merchantUrl: typeof item.merchant_url === 'string' ? item.merchant_url : null,
        totalAmount: typeof item.total_amount === 'string' ? item.total_amount : '0.00',
        status: typeof item.status === 'string' ? item.status : status,
        tokenLast4: token ? token.slice(-4) : null,
      }];
    });

    const rawError = firstTransaction?.error;
    const errorRecord = rawError && typeof rawError === 'object' && !Array.isArray(rawError)
      ? rawError as Record<string, unknown>
      : null;
    const safeError = errorRecord
      ? {
          code: typeof errorRecord.code === 'string' ? errorRecord.code.slice(0, 100) : '',
          message: typeof errorRecord.message === 'string' ? errorRecord.message.slice(0, 300) : '',
        }
      : undefined;

    return {
      sessionId: returnedSessionId,
      orderId: typeof data.order_id === 'string' ? data.order_id : null,
      status,
      lineItems,
      error: safeError,
    };
  }

  async pollPaymentResult(sessionId: string): Promise<PaymentResult> {
    return this.mapPaymentResult(await this.rawPaymentResult(sessionId), sessionId);
  }

  async fetchCredentialForClaimedExecution(attemptId: string): Promise<PravaExecutionCredential> {
    assertMerchantExecutionEnabled('prava:read-execution-credential');
    const { data: attemptData, error: attemptError } = await getSupabaseAdmin()
      .from('checkout_attempts')
      .select(`
        id,
        status,
        amount_minor,
        purchase_orders!inner(state, authorized_total_minor, currency),
        payment_sessions!inner(provider_session_id, status, amount_minor, currency, expires_at)
      `)
      .eq('id', attemptId)
      .maybeSingle();
    if (attemptError) throw new Error(`Checkout claim read failed: ${attemptError.code}`);
    if (!attemptData || attemptData.status !== 'running') throw new Error('Checkout attempt is not claimed');
    const order = Array.isArray(attemptData.purchase_orders)
      ? attemptData.purchase_orders[0]
      : attemptData.purchase_orders;
    const session = Array.isArray(attemptData.payment_sessions)
      ? attemptData.payment_sessions[0]
      : attemptData.payment_sessions;
    if (!order || !session || order.state !== 'executing' || session.status !== 'processing') {
      throw new Error('Checkout attempt is not bound to an executing payment session');
    }
    const expectedMinor = BigInt(String(attemptData.amount_minor));
    if (
      expectedMinor !== BigInt(String(order.authorized_total_minor)) ||
      expectedMinor !== BigInt(String(session.amount_minor)) ||
      order.currency !== session.currency ||
      Date.parse(session.expires_at) <= Date.now()
    ) {
      throw new Error('Claimed payment amount, currency, or expiry does not match');
    }

    const sessionId = String(session.provider_session_id);
    const data = await this.rawPaymentResult(sessionId);
    if (data.status !== 'awaiting_result') throw new Error('Prava credential is not ready for execution');
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    const transaction = asRecord(transactions[0]);
    const lineItems = Array.isArray(transaction.line_items) ? transaction.line_items : [];
    if (lineItems.length !== 1) throw new Error('Expected one Prava merchant line item');
    const item = asRecord(lineItems[0]);
    const credential = {
      txnRefId: requiredString(item, 'txn_ref_id', 255),
      amount: requiredString(item, 'total_amount', 40),
      token: requiredString(item, 'token', 32),
      dynamicCvv: requiredString(item, 'dynamic_cvv', 8),
      expiryMonth: requiredString(item, 'expiry_month', 2),
      expiryYear: requiredString(item, 'expiry_year', 4),
    };
    if (!/^\d{13,19}$/.test(credential.token) || !/^\d{3,4}$/.test(credential.dynamicCvv)) {
      throw new Error('Prava returned an invalid one-time credential');
    }
    if (parseDecimalToMinor(credential.amount, currencyExponent(order.currency)) !== expectedMinor) {
      throw new Error('Prava credential amount does not match the claimed checkout total');
    }
    return credential;
  }

  private async reportToPrava(sessionId: string, params: {
    txnRefId: string;
    txnStatus: 'APPROVED' | 'DECLINED';
    amountPaid: string;
    authorizationCode: string | null;
    responseCode: string;
  }): Promise<PravaReportResult> {
    if (!params.txnRefId) throw new Error('A real Prava transaction reference is required');
    if (!params.responseCode || !/^[A-Za-z0-9]{1,2}$/.test(params.responseCode)) {
      throw new Error('A real processor response code is required');
    }
    if (params.txnStatus === 'APPROVED' && !params.authorizationCode) {
      throw new Error('A real processor authorization code is required for approval');
    }
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/report-status`, {
      method: 'POST',
      body: JSON.stringify({
        txn_ref_id: params.txnRefId,
        txn_status: params.txnStatus,
        txn_type: 'PURCHASE',
        amount_paid: params.amountPaid,
        ...(params.authorizationCode ? { authorization_code: params.authorizationCode } : {}),
        response_code: params.responseCode,
      }),
    }, 'status reporting');
    const data = asRecord(await response.json());
    const status = requiredString(data, 'status', 50);
    const txnStatus = requiredString(data, 'txn_status', 50);
    const visaConfirmation = requiredString(data, 'visa_confirmation', 50);
    return {
      status,
      txnStatus,
      visaConfirmation,
      responseId: response.headers.get('x-response-id'),
      txn_status: txnStatus,
      visa_confirmation: visaConfirmation,
    };
  }

  async reportClaimedTransaction(reportId: string): Promise<PravaReportResult> {
    const admin = getSupabaseAdmin();
    const { data: reportData, error: reportError } = await admin
      .from('transaction_reports')
      .select(`
        id,
        status,
        txn_ref_id,
        prava_session_id,
        attempt_count,
        checkout_attempts!inner(
          status,
          amount_minor,
          merchant_order_id,
          processor_authorization_code,
          processor_response_code,
          purchase_orders!inner(currency),
          payment_sessions!inner(provider_session_id)
        )
      `)
      .eq('id', reportId)
      .maybeSingle();
    if (reportError) throw new Error(`Transaction report read failed: ${reportError.code}`);
    if (!reportData) throw new Error('Transaction report not found');
    if (reportData.status === 'confirmed') throw new Error('Transaction report is already confirmed');

    const attempt = Array.isArray(reportData.checkout_attempts)
      ? reportData.checkout_attempts[0]
      : reportData.checkout_attempts;
    const order = Array.isArray(attempt?.purchase_orders)
      ? attempt.purchase_orders[0]
      : attempt?.purchase_orders;
    const session = Array.isArray(attempt?.payment_sessions)
      ? attempt.payment_sessions[0]
      : attempt?.payment_sessions;
    if (!attempt || !order || !session || session.provider_session_id !== reportData.prava_session_id) {
      throw new Error('Transaction report is not bound to its payment session');
    }
    if (attempt.status !== 'approved' && attempt.status !== 'declined') {
      throw new Error('Merchant outcome is not authoritative');
    }
    if (attempt.status === 'approved' && !attempt.merchant_order_id) {
      throw new Error('Approved merchant outcome is missing an order reference');
    }
    const responseCode = typeof attempt.processor_response_code === 'string'
      ? attempt.processor_response_code
      : '';
    const authorizationCode = typeof attempt.processor_authorization_code === 'string'
      ? attempt.processor_authorization_code
      : null;
    const exponent = currencyExponent(String(order.currency));

    const leaseToken = crypto.randomUUID();
    const { data: claimData, error: claimError } = await admin.rpc('claim_transaction_report', {
      p_report_id: reportId,
      p_lease_token: leaseToken,
      p_lease_seconds: 60,
    });
    if (claimError) throw new Error(`Transaction report claim failed: ${claimError.code}`);
    const claim = Array.isArray(claimData) ? claimData[0] : claimData;
    if (!claim?.claimed) throw new Error('Transaction report is already being processed');
    const nextAttemptCount = Number(claim.attempt_count);

    try {
      const result = await this.reportToPrava(String(reportData.prava_session_id), {
        txnRefId: String(reportData.txn_ref_id),
        txnStatus: attempt.status === 'approved' ? 'APPROVED' : 'DECLINED',
        amountPaid: formatMinorAmount(BigInt(String(attempt.amount_minor)), exponent),
        authorizationCode,
        responseCode,
      });
      const confirmed = result.visaConfirmation === 'SUCCESS';
      const { data: updatedReport, error: updateError } = await admin
        .from('transaction_reports')
        .update({
          status: confirmed ? 'confirmed' : 'failed',
          attempt_count: nextAttemptCount,
          next_attempt_at: confirmed ? null : new Date(Date.now() + 60_000).toISOString(),
          last_error_code: confirmed ? null : 'VISA_CONFIRMATION_FAILURE',
          response_id: result.responseId,
          lease_token: null,
          lease_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', reportId)
        .eq('status', 'reporting')
        .eq('lease_token', leaseToken)
        .select('id')
        .maybeSingle();
      if (updateError) throw new Error(`Transaction report update failed: ${updateError.code}`);
      if (!updatedReport) throw new Error('Transaction report lease was lost after provider response');
      return result;
    } catch (error) {
      const code = error instanceof PravaApiError
        ? error.providerCode || `HTTP_${error.status}`
        : 'REPORT_FAILED';
      const { data: failedReport, error: failureError } = await admin
        .from('transaction_reports')
        .update({
          status: 'failed',
          attempt_count: nextAttemptCount,
          next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
          last_error_code: code.slice(0, 100),
          lease_token: null,
          lease_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', reportId)
        .eq('status', 'reporting')
        .eq('lease_token', leaseToken)
        .select('id')
        .maybeSingle();
      if (failureError) throw new Error(`Transaction report failure update failed: ${failureError.code}`);
      if (!failedReport) throw new Error('Transaction report lease was lost');
      throw error;
    }
  }

  async listCards(customerId: string): Promise<SavedCard[]> {
    if (!/^[0-9a-f-]{36}$/i.test(customerId)) throw new Error('Invalid Prava customer ID');
    const response = await this.request(
      `/v1/listCards?customer_id=${encodeURIComponent(customerId)}&status=active`,
      { method: 'GET' },
      'card listing'
    );
    const data = asRecord(await response.json());
    const cards = Array.isArray(data.cards) ? data.cards : [];
    return cards.flatMap((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const card = value as Record<string, unknown>;
      if (
        typeof card.card_id !== 'string' ||
        typeof card.card_last4 !== 'string' ||
        !/^\d{4}$/.test(card.card_last4)
      ) return [];
      return [{
        cardId: card.card_id,
        cardLast4: card.card_last4,
        cardBrand: typeof card.card_brand === 'string' ? card.card_brand : '',
        cardExpMonth: String(card.card_exp_month ?? ''),
        cardExpYear: String(card.card_exp_year ?? ''),
        maskedCardNumber: `**** **** **** ${card.card_last4}`,
        status: typeof card.status === 'string' ? card.status : 'active',
      }];
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/revoke`, { method: 'POST' }, 'session revocation');
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const pravaClient = new PravaClient();
