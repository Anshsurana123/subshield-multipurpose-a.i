-- Users: stores Browserbase context IDs for persistent sessions
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  browserbase_context_id TEXT,          -- persistent browser session
  push_subscription JSONB,             -- Web Push subscription object
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Subscriptions: discovered from Gmail/Google Subs
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL,
  domain TEXT,
  category TEXT,
  current_price DECIMAL(10,2),
  previous_price DECIMAL(10,2),
  currency TEXT DEFAULT 'USD',
  status TEXT CHECK (status IN ('healthy','price-hiked','unused','duplicate','trial')),
  renewal_date TIMESTAMPTZ,
  source TEXT CHECK (source IN ('gmail','google_subs')),
  replacement_difficulty TEXT CHECK (replacement_difficulty IN ('easy','hard')),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, vendor)
);

-- Alternatives: cached competitor options
CREATE TABLE IF NOT EXISTS alternatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price DECIMAL(10,2),
  feature_parity DECIMAL(3,2),
  features TEXT[],
  url TEXT,
  fetched_at TIMESTAMPTZ DEFAULT now()
);

-- Decisions: AI decision log
CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('auto_switch','negotiate','user_input')),
  status TEXT CHECK (status IN ('pending','in_progress','executed','rejected','expired')),
  alternative_id UUID REFERENCES alternatives(id),
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Negotiation logs: full transcript storage
CREATE TABLE IF NOT EXISTS negotiation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES decisions(id),
  events JSONB NOT NULL DEFAULT '[]',
  outcome TEXT,
  discount_offered DECIMAL(10,2),
  target_price DECIMAL(10,2),
  channel TEXT CHECK (channel IN ('website','email','both')),
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Scan history: audit trail
CREATE TABLE IF NOT EXISTS scan_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  source TEXT,
  subscriptions_found INTEGER DEFAULT 0,
  status TEXT CHECK (status IN ('running','completed','failed')),
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Notifications: push notification log
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES decisions(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT CHECK (type IN ('switch_suggestion','negotiation_failed','renewal_warning','price_hike_alert')),
  sent_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ,
  action_taken TEXT
);
