export type SubscriptionSource = 'gmail' | 'google_subs';
export type ReplacementDifficulty = 'easy' | 'hard';
export type DecisionType = 'auto_switch' | 'negotiate' | 'user_input';
export type DecisionStatus = 'pending' | 'in_progress' | 'executed' | 'rejected' | 'expired';
export type NotificationType = 'switch_suggestion' | 'negotiation_failed' | 'renewal_warning' | 'price_hike_alert';

export interface UserRecord {
  id: string;
  email: string | null;
  browserbase_context_id: string | null;
  push_subscription: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRecord {
  id: string;
  user_id: string;
  vendor: string;
  domain: string | null;
  category: string | null;
  current_price: number;
  previous_price: number | null;
  currency: string;
  status: 'healthy' | 'price-hiked' | 'unused' | 'duplicate' | 'trial';
  renewal_date: string | null;
  source: SubscriptionSource;
  replacement_difficulty: ReplacementDifficulty | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface AlternativeRecord {
  id: string;
  subscription_id: string;
  name: string;
  price: number;
  feature_parity: number;
  features: string[];
  url: string | null;
  fetched_at: string;
}

export interface DecisionRecord {
  id: string;
  subscription_id: string;
  type: DecisionType;
  status: DecisionStatus;
  alternative_id: string | null;
  reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface NotificationRecord {
  id: string;
  user_id: string;
  decision_id: string | null;
  title: string;
  body: string;
  type: NotificationType;
  sent_at: string;
  read_at: string | null;
  action_taken: string | null;
}
