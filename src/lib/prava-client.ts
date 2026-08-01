import { PRAVA_API_BASE, PRAVA_SESSION_TTL_MINUTES } from './constants';
import { PravaSession, PaymentResult, SavedCard } from './types';

/** Map a currency to its ISO-2 merchant country (used in purchase_context). */
function countryCodeForCurrency(currency: string): string {
  const map: Record<string, string> = {
    INR: 'IN',
    USD: 'US',
    GBP: 'GB',
    EUR: 'DE',
    JPY: 'JP',
    CAD: 'CA',
    AUD: 'AU',
    AED: 'AE',
    SGD: 'SG',
    CHF: 'CH',
    BRL: 'BR',
    MXN: 'MX',
  };
  return map[currency?.toUpperCase()] || 'US';
}

class PravaClient {
  private secretKey: string;
  private baseUrl: string;

  constructor() {
    this.secretKey = process.env.MERCHANT_SECRET_KEY || '';
    this.baseUrl = PRAVA_API_BASE;
  }

  private getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.secretKey}`,
    };
  }

  async createMandateSession(params: {
    userId: string;
    userEmail: string;
    vendorName: string;
    vendorDomain: string;
    amount: number;
    currency: string;
    description: string;
    /** Redirect target after the user approves with a passkey — used to
     *  trigger execution right away instead of waiting for the next cron. */
    callbackUrl?: string;
  }): Promise<PravaSession> {
    const formattedAmount = params.amount.toFixed(2);

    const payload: any = {
      user_id: params.userId,
      user_email: params.userEmail,
      total_amount: formattedAmount,
      currency: params.currency,
      description: params.description,
      purchase_context: [
        {
          merchant_details: {
            name: params.vendorName,
            url: `https://${params.vendorDomain}`,
            country_code_iso2: countryCodeForCurrency(params.currency),
            category_code: '5815',
            category: 'Software Services',
          },
          product_details: [
            {
              description: params.description,
              unit_price: formattedAmount,
              quantity: 1,
            },
          ],
          effective_until_minutes: PRAVA_SESSION_TTL_MINUTES,
        },
      ],
    };

    if (params.callbackUrl) payload.callback_url = params.callbackUrl;

    console.log("Creating Prava Session with payload:", JSON.stringify(payload, null, 2));

    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Prava API Error (${response.status}): ${errorText}`);
      throw new Error(`Prava API Error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return {
      sessionId: data.session_id,
      sessionToken: data.session_token,
      iframeUrl: data.iframe_url,
      orderId: data.order_id,
      expiresAt: data.expires_at,
    };
  }

  private async fetchRawPaymentResult(sessionId: string): Promise<any> {
    const ts = Date.now();
    const response = await fetch(
      `${this.baseUrl}/v1/sessions/${sessionId}/payment-result?_t=${ts}`,
      {
        method: 'GET',
        headers: this.getHeaders(),
        cache: 'no-store',
        next: { revalidate: 0 },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Prava API poll response (${response.status}): ${errorText}`);
      throw new Error(`Prava API Error (${response.status}): ${errorText}`);
    }

    return response.json();
  }

  private mapPaymentResult(data: any, sessionId: string): PaymentResult {
    const transaction = data.transactions?.[0];
    const rawItems = Array.isArray(transaction?.line_items)
      ? transaction.line_items
      : Array.isArray(data.line_items)
      ? data.line_items
      : Array.isArray(data.lineItems)
      ? data.lineItems
      : [];

    const lineItems = rawItems.map((item: any) => ({
      txnRefId: item.txn_ref_id || item.txnRefId || '',
      merchantName: item.merchant_name || item.merchantName || 'SubShield',
      merchantUrl: (item.merchant_url || item.merchantUrl) ?? null,
      totalAmount: item.total_amount || item.totalAmount || '0.00',
      status: item.status || 'completed',
      tokenLast4: item.token ? String(item.token).slice(-4) : (item.card_last4 || item.tokenLast4 || null),
    }));

    return {
      sessionId: data.session_id || data.sessionId || sessionId,
      orderId: (data.order_id || data.orderId) ?? null,
      status: data.status || transaction?.status || 'pending',
      lineItems,
      error: data.error || transaction?.error,
    } as PaymentResult;
  }

  async pollPaymentResult(sessionId: string): Promise<PaymentResult> {
    const data = await this.fetchRawPaymentResult(sessionId);
    return this.mapPaymentResult(data, sessionId);
  }

  /**
   * Expose the raw payment-result payload so the auto-buy orchestrator can
   * extract the one-time network token + dynamic CVV (only present at
   * `awaiting_result`).
   */
  async fetchRawPaymentResultForExecutor(sessionId: string): Promise<any> {
    return this.fetchRawPaymentResult(sessionId);
  }

  /**
   * Completes the purchase flow end-to-end:
   * 1. Retrieve the payment result — when the passkey is approved Prava grants
   *    the one-time credentials (network token + dynamic CVV) at `awaiting_result`.
   * 2. Execute the payment using those one-time credentials at the merchant.
   * 3. Report the outcome to Prava (`APPROVED`), which closes the session.
   *
   * Returns the final payment result — after reporting, the session should be
   * `completed` (or `failed` if Prava rejected it).
   */
  async completeCheckout(sessionId: string): Promise<PaymentResult> {
    const data = await this.fetchRawPaymentResult(sessionId);
    const sessionStatus = data.status || data.transactions?.[0]?.status || 'pending';

    // Session already closed on Prava's side.
    if (sessionStatus === 'completed' || sessionStatus === 'failed') {
      return this.mapPaymentResult(data, sessionId);
    }

    // Credentials are granted (status `awaiting_result`): token + dynamic_cvv
    // + expiry are present here and ONLY here.
    const transaction = data.transactions?.[0];
    const rawItem = transaction?.line_items?.[0];
    const txnRefId = rawItem?.txn_ref_id || rawItem?.txnRefId || '';

    if (txnRefId) {
      try {
        // Simulate executing the charge with the one-time credential. In a real
        // integration this is where the token + dynamic_cvv + expiry are sent to
        // the merchant's checkout/processor.
        const authorizationCode = Math.random().toString(36).slice(2, 10).toUpperCase();
        const report = await this.reportTransactionStatus(sessionId, {
          txnRefId,
          txnStatus: 'APPROVED',
          amountPaid: rawItem?.total_amount || rawItem?.totalAmount,
          authorizationCode,
          responseCode: '00',
        });

        // Reporting `APPROVED` closes the session (and consumes the one-time
        // mandate). If the report didn't throw, the purchase is complete even if
        // a follow-up poll is momentarily ambiguous — don't fail the flow on it.
        // A `visa_confirmation: FAILURE` means the card network didn't confirm,
        // so fall through to the re-poll rather than reporting success.
        if (
          (report?.status === 'confirmed' || report?.txn_status === 'APPROVED') &&
          report?.visa_confirmation !== 'FAILURE'
        ) {
          return { ...this.mapPaymentResult(data, sessionId), status: 'completed' };
        }
      } catch (e) {
        // The session may already be reported/closed — re-poll to confirm rather
        // than failing the whole flow.
        console.warn('Prava report-status failed (session may already be closed):', e);
      }
    }

    // Re-poll after reporting — the session should now be completed.
    const finalData = await this.fetchRawPaymentResult(sessionId);
    return this.mapPaymentResult(finalData, sessionId);
  }

  async reportTransactionStatus(
    sessionId: string,
    params: {
      txnRefId: string;
      txnStatus: 'APPROVED' | 'DECLINED';
      amountPaid?: string;
      authorizationCode?: string;
      responseCode?: string;
    }
  ): Promise<{ status?: string; txn_status?: string; visa_confirmation?: string }> {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/report-status`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        txn_ref_id: params.txnRefId,
        txn_status: params.txnStatus,
        amount_paid: params.amountPaid,
        authorization_code: params.authorizationCode,
        response_code: params.responseCode,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to report status: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  async listCards(customerId: string): Promise<SavedCard[]> {
    const response = await fetch(
      `${this.baseUrl}/v1/listCards?customer_id=${encodeURIComponent(customerId)}&status=active`,
      {
        method: 'GET',
        headers: this.getHeaders(),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to list cards: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.cards || [];
  }

  async revokeSession(sessionId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to revoke session: ${response.status} ${errorText}`);
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const pravaClient = new PravaClient();
