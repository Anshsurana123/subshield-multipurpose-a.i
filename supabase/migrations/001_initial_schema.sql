-- Canonical clean-install baseline.
-- Existing deployments created from the legacy version are repaired by 005.

-- Application profile data. The primary key is the authenticated Supabase user;
-- application code must never create an unrelated user identity here.
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE,
  browserbase_context_id TEXT,
  push_subscription JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL,
  domain TEXT,
  category TEXT,
  current_price NUMERIC(12,2) CHECK (current_price IS NULL OR current_price >= 0),
  previous_price NUMERIC(12,2) CHECK (previous_price IS NULL OR previous_price >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT CHECK (status IN ('healthy','price-hiked','unused','duplicate','trial')),
  renewal_date TIMESTAMPTZ,
  source TEXT CHECK (source IN ('gmail','google_subs')),
  replacement_difficulty TEXT CHECK (replacement_difficulty IN ('easy','hard')),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, vendor)
);

CREATE TABLE IF NOT EXISTS public.alternatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price NUMERIC(12,2) CHECK (price IS NULL OR price >= 0),
  feature_parity NUMERIC(3,2) CHECK (feature_parity IS NULL OR (feature_parity >= 0 AND feature_parity <= 1)),
  features TEXT[],
  url TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('auto_switch','negotiate','user_input')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','executed','rejected','expired')),
  alternative_id UUID REFERENCES public.alternatives(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.negotiation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES public.decisions(id) ON DELETE SET NULL,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome TEXT,
  discount_offered NUMERIC(12,2) CHECK (discount_offered IS NULL OR discount_offered >= 0),
  target_price NUMERIC(12,2) CHECK (target_price IS NULL OR target_price >= 0),
  channel TEXT CHECK (channel IN ('website','email','both')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.scan_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source TEXT,
  subscriptions_found INTEGER NOT NULL DEFAULT 0 CHECK (subscriptions_found >= 0),
  status TEXT CHECK (status IN ('running','completed','failed')),
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES public.decisions(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT CHECK (type IN ('switch_suggestion','negotiation_failed','renewal_warning','price_hike_alert')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  action_taken TEXT
);

-- Postgres does not automatically index foreign-key columns.
CREATE INDEX IF NOT EXISTS alternatives_subscription_id_idx ON public.alternatives(subscription_id);
CREATE INDEX IF NOT EXISTS decisions_subscription_id_idx ON public.decisions(subscription_id);
CREATE INDEX IF NOT EXISTS decisions_alternative_id_idx ON public.decisions(alternative_id) WHERE alternative_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS negotiation_logs_subscription_id_idx ON public.negotiation_logs(subscription_id);
CREATE INDEX IF NOT EXISTS negotiation_logs_decision_id_idx ON public.negotiation_logs(decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_history_user_started_idx ON public.scan_history(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_sent_idx ON public.notifications(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS notifications_decision_id_idx ON public.notifications(decision_id) WHERE decision_id IS NOT NULL;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alternatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.negotiation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_select_own ON public.users
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = id);
CREATE POLICY users_insert_own ON public.users
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id);
CREATE POLICY users_update_own ON public.users
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY subscriptions_select_own ON public.subscriptions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY alternatives_select_own ON public.alternatives
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.subscriptions AS s
    WHERE s.id = subscription_id AND s.user_id = (SELECT auth.uid())
  ));
CREATE POLICY decisions_select_own ON public.decisions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.subscriptions AS s
    WHERE s.id = subscription_id AND s.user_id = (SELECT auth.uid())
  ));
CREATE POLICY negotiation_logs_select_own ON public.negotiation_logs
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.subscriptions AS s
    WHERE s.id = subscription_id AND s.user_id = (SELECT auth.uid())
  ));
CREATE POLICY scan_history_select_own ON public.scan_history
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY notifications_select_own ON public.notifications
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Explicit Data API privileges. Anonymous access is intentionally absent.
REVOKE ALL PRIVILEGES ON TABLE
  public.users,
  public.subscriptions,
  public.alternatives,
  public.decisions,
  public.negotiation_logs,
  public.scan_history,
  public.notifications
FROM PUBLIC, anon, authenticated;

GRANT SELECT (id, email, created_at, updated_at)
  ON TABLE public.users TO authenticated;
GRANT INSERT (id, email)
  ON TABLE public.users TO authenticated;
GRANT UPDATE (email, updated_at)
  ON TABLE public.users TO authenticated;
GRANT SELECT ON TABLE
  public.subscriptions,
  public.alternatives,
  public.decisions,
  public.negotiation_logs,
  public.scan_history,
  public.notifications
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.users,
  public.subscriptions,
  public.alternatives,
  public.decisions,
  public.negotiation_logs,
  public.scan_history,
  public.notifications
TO service_role;
