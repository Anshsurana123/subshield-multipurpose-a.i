// ─── Tracked Product (read-only target alerts) ────────────────────────────────

export type TrackedProductStatus = 'active' | 'target_reached' | 'purchased' | 'cancelled' | 'unknown_reconciliation';

export type ChatChannel = 'telegram' | 'linq';

export interface TrackedProduct {
  id: string;
  userId: string;
  productUrl: string;
  productName: string;
  currentPrice: number;
  targetPrice: number;
  currency: string;
  status: TrackedProductStatus;
  lastScannedAt?: string;
  createdAt: string;
  updatedAt: string;
  /** Which chat channel enrolled this product ('telegram' | 'linq' | 'web') */
  sourceChannel?: 'telegram' | 'linq' | 'web';
  /** Chat ID used to notify the user when the price target is hit */
  sourceChatId?: string;
  /** Provider event key used only by trusted workers for idempotency. */
  sourceEventId?: string;
  /** Legacy server-only migration field; never returned by the tracker API. */
  pravaSessionId?: string;
}

// ─── Subscription (after DISCOVER audit) ──────────────────────────────────────

export type SubscriptionStatus =
  | 'healthy'
  | 'price-hiked'
  | 'unused'
  | 'duplicate'
  | 'trial';

export type SubscriptionSource = 'gmail' | 'google_subs';
export type ReplacementDifficulty = 'easy' | 'hard';

export interface Subscription {
  id: string;
  vendor: string;
  currentPrice: number;
  previousPrice: number | null;
  currency: string;
  billingCycle: 'monthly' | 'annual';
  category: string;
  status: SubscriptionStatus;
  priceChangePercent: number | null;
  lastUsed: string | null;
  duplicateOf: string | null;
  merchantDomain: string;
  iconUrl: string;
  savingsPotential: number;
  priceHistory: { date: string; amount: number }[];
  source: SubscriptionSource;
  replacementDifficulty?: ReplacementDifficulty;
  renewalDate?: string;
}

export interface ParsedSubscription {
  vendor: string;
  amount: number;
  currency: string;
  billingCycle?: 'monthly' | 'annual';
  category?: string;
  merchantDomain?: string;
  renewalDate?: string;
  lastSeenDate?: string;
  source: SubscriptionSource;
  emailSubject?: string;
}

// ─── Alternative (DECIDE — market arbitrage) ──────────────────────────────────

export interface Alternative {
  id?: string;
  name: string;
  price: number;
  currency: string;
  features: string[];
  featureParityScore: number;
  url: string;
  iconUrl?: string;
  savings: number;
  fetchedAt?: string;
}

// ─── Decisions (DECIDE — AI Decision Engine) ─────────────────────────────────

export type DecisionType = 'auto_switch' | 'negotiate' | 'user_input';
export type DecisionStatus = 'pending' | 'in_progress' | 'executed' | 'rejected' | 'expired';

export interface Decision {
  id: string;
  subscriptionId: string;
  type: DecisionType;
  status: DecisionStatus;
  alternative?: Alternative;
  reason: string;
  createdAt: string;
  resolvedAt?: string;
}

// ─── Notifications (Web Push & UI Alert Center) ───────────────────────────────

export type NotificationType = 'switch_suggestion' | 'negotiation_failed' | 'renewal_warning' | 'price_hike_alert';

export interface NotificationItem {
  id: string;
  userId: string;
  decisionId?: string;
  subscriptionId?: string;
  title: string;
  body: string;
  type: NotificationType;
  sentAt: string;
  readAt?: string;
  actionTaken?: string;
}

// ─── Negotiation (DECIDE — agent transcript) ──────────────────────────────────

export type NegotiationActor = 'AGENT' | 'VENDOR' | 'SYSTEM';
export type NegotiationEventType = 'action' | 'response' | 'offer' | 'result' | 'error';
export type NegotiationChannel = 'website' | 'email' | 'both';

export interface NegotiationEvent {
  timestamp: string;
  actor: NegotiationActor;
  message: string;
  type: NegotiationEventType;
}

export interface NegotiationResult {
  subscriptionId: string;
  accepted: boolean;
  originalPrice: number;
  finalPrice: number;
  vendor: string;
  channel: NegotiationChannel;
  switchTo?: Alternative;
  events: NegotiationEvent[];
  savings: number;
  savingsAnnual: number;
}

// ─── Prava Mandate (ACT phase) ────────────────────────────────────────────────

export type MandateStatus =
  | 'creating'
  | 'pending-checkout'
  | 'polling'
  | 'active'
  | 'completed'
  | 'expired'
  | 'revoked'
  | 'failed';

export interface Mandate {
  id: string;
  sessionId: string;
  vendor: string;
  merchantDomain: string;
  amount: number;
  currency: string;
  status: MandateStatus;
  createdAt: string;
  expiresAt: string;
  negotiatedFrom: number | null;
  checkoutOutcome?: CheckoutOutcome;
}

// ─── Prava Session ────────────────────────────────────────────────────────────

export interface PravaSession {
  sessionId: string;
  sessionToken: string;
  iframeUrl: string;
  orderId: string;
  expiresAt: string;
}

export interface PravaLineItem {
  txnRefId: string;
  merchantName: string;
  merchantUrl: string | null;
  totalAmount: string;
  status: string;
  tokenLast4: string | null;
}

export interface PaymentResult {
  sessionId: string;
  orderId: string | null;
  status: 'pending' | 'awaiting_result' | 'completed' | 'failed' | string;
  lineItems?: PravaLineItem[];
  error?: { code?: string; message?: string };
}

export interface CheckoutOutcome {
  sessionId: string;
  orderId: string;
  status: 'verified' | 'completed' | 'failed';
  tokenLast4: string;
  amountPaid: string;
  merchantName: string;
  reportedToVisa: boolean;
  authorizationCode: string;
  completedAt: string;
}

// ─── Saved Card ───────────────────────────────────────────────────────────────

export interface SavedCard {
  cardId: string;
  cardLast4: string;
  cardBrand: string;
  cardExpMonth: string;
  cardExpYear: string;
  maskedCardNumber: string;
  status: string;
}

// ─── Store State ──────────────────────────────────────────────────────────────

export type AuditPhase = 'idle' | 'scanning_gmail' | 'scanning_subs' | 'analyzing' | 'complete';
export type NegotiationPhase = 'idle' | 'searching-alternatives' | 'negotiating' | 'awaiting-decision' | 'complete';
export type CheckoutPhase = 'idle' | 'creating' | 'card-entry' | 'polling' | 'reporting' | 'completed' | 'failed';

// ─── API Request / Response Shapes ────────────────────────────────────────────

export interface CreateSessionRequest {
  purchaseOrderId: string;
  expectedVersion: number;
}

export interface AuditRequest {
  parsedSubscriptions?: ParsedSubscription[];
  contextId?: string;
}

export interface NegotiateRequest {
  subscriptionId: string;
  vendor: string;
  currentPrice: number;
  targetPrice?: number;
  merchantDomain: string;
  channel?: NegotiationChannel;
  alternatives?: Alternative[];
}
