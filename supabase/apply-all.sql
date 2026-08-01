-- ═══════════════════════════════════════════════════════════════════════════════
-- SubShield — FULL SCHEMA (apply-all)
-- Paste this ENTIRE file into Supabase SQL Editor → Run.
-- It is idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  browserbase_context_id TEXT,
  push_subscription JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Subscriptions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
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

-- ─── Alternatives ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.alternatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price DECIMAL(10,2),
  feature_parity DECIMAL(3,2),
  features TEXT[],
  url TEXT,
  fetched_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Decisions ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('auto_switch','negotiate','user_input')),
  status TEXT CHECK (status IN ('pending','in_progress','executed','rejected','expired')),
  alternative_id UUID REFERENCES public.alternatives(id),
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- ─── Negotiation logs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.negotiation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES public.decisions(id),
  events JSONB NOT NULL DEFAULT '[]',
  outcome TEXT,
  discount_offered DECIMAL(10,2),
  target_price DECIMAL(10,2),
  channel TEXT CHECK (channel IN ('website','email','both')),
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ─── Scan history ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scan_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  source TEXT,
  subscriptions_found INTEGER DEFAULT 0,
  status TEXT CHECK (status IN ('running','completed','failed')),
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ─── Notifications ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  decision_id UUID REFERENCES public.decisions(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT CHECK (type IN ('switch_suggestion','negotiation_failed','renewal_warning','price_hike_alert')),
  sent_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ,
  action_taken TEXT
);

-- ─── Tracked Products (Price Tracker + Prava Auto-Buy) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.tracked_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ⚠️ TEXT, NOT a UUID FK: chat users enroll as 'tg_123456' / 'linq_abc' and
  -- never exist in public.users. A UUID FK made inserts fail — fixed here.
  user_id TEXT NOT NULL,
  product_url TEXT NOT NULL,
  product_name TEXT NOT NULL,
  current_price NUMERIC(10, 2) NOT NULL,
  target_price NUMERIC(10, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'active', -- 'active','target_reached','purchased','cancelled'
  last_scanned_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  -- 003: chat back-link so we can notify the originating conversation
  source_channel TEXT,                   -- 'telegram' | 'linq' | 'web'
  source_chat_id TEXT,
  -- 004: open Prava session for resumable auto-buy
  prava_session_id TEXT
);

-- Drop the old broken FK (harmless if already dropped / never existed)
ALTER TABLE public.tracked_products DROP CONSTRAINT IF EXISTS tracked_products_user_id_fkey;

-- Idempotency against partial history: if the table pre-existed from 002 but
-- 003/004 were never applied, these columns would be missing (the CREATE above
-- is skipped). ADD COLUMN IF NOT EXISTS covers every case.
ALTER TABLE public.tracked_products ADD COLUMN IF NOT EXISTS source_channel TEXT;
ALTER TABLE public.tracked_products ADD COLUMN IF NOT EXISTS source_chat_id TEXT;
ALTER TABLE public.tracked_products ADD COLUMN IF NOT EXISTS prava_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tracked_products_user_status ON public.tracked_products(user_id, status);

ALTER TABLE public.tracked_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own tracked products" ON public.tracked_products;
CREATE POLICY "Users can manage their own tracked products"
ON public.tracked_products FOR ALL
USING (true);
