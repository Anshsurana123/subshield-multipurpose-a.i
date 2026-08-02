-- Migration 006: durable, multi-user purchase foundation.
--
-- This is also the forward repair for installations created from the legacy
-- 001/002 migrations. It never derives application ownership from a chat ID:
-- incompatible tracker rows are preserved in tracked_products_legacy, and
-- orphaned public.users rows stop the migration with an actionable error.

BEGIN;

-- Make Data API exposure opt-in for all future public objects. Every object in
-- this migration receives an explicit grant below.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
  FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES
  FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Link the legacy public.users profile table to Supabase Auth.
-- ---------------------------------------------------------------------------

DO $migration$
DECLARE
  orphan_count BIGINT;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'public.users is missing; apply migration 001 before 005';
  END IF;

  SELECT count(*)
    INTO orphan_count
  FROM public.users AS profile
  LEFT JOIN auth.users AS auth_user ON auth_user.id = profile.id
  WHERE auth_user.id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      USING
        MESSAGE = format('cannot link public.users to auth.users: %s orphaned profile row(s)', orphan_count),
        DETAIL = 'No ownership inference or synthetic Auth user creation was attempted.',
        HINT = 'Export and reconcile the orphaned public.users rows to real auth.users IDs, then rerun migration 005.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    JOIN pg_attribute AS column_record
      ON column_record.attrelid = constraint_record.conrelid
     AND column_record.attnum = ANY (constraint_record.conkey)
    WHERE constraint_record.contype = 'f'
      AND constraint_record.conrelid = 'public.users'::regclass
      AND constraint_record.confrelid = 'auth.users'::regclass
      AND column_record.attname = 'id'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_user_id_fkey
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END
$migration$;

-- An application profile ID must always be supplied by Auth.
ALTER TABLE public.users ALTER COLUMN id DROP DEFAULT;

-- ---------------------------------------------------------------------------
-- Preserve incompatible legacy tracker/pending-order rows without assigning
-- them to an authenticated user. The service role may export the quarantine;
-- no application role can read or mutate it.
-- ---------------------------------------------------------------------------

DO $migration$
DECLARE
  user_id_type TEXT;
  policy_record RECORD;
BEGIN
  IF to_regclass('public.tracked_products') IS NULL THEN
    RAISE EXCEPTION 'public.tracked_products is missing; apply migration 002 before 005';
  END IF;

  SELECT format_type(column_record.atttypid, column_record.atttypmod)
    INTO user_id_type
  FROM pg_attribute AS column_record
  WHERE column_record.attrelid = 'public.tracked_products'::regclass
    AND column_record.attname = 'user_id'
    AND NOT column_record.attisdropped;

  IF user_id_type IS NULL THEN
    RAISE EXCEPTION 'public.tracked_products.user_id is missing';
  END IF;

  IF user_id_type <> 'uuid' THEN
    IF to_regclass('public.tracked_products_legacy') IS NOT NULL THEN
      RAISE EXCEPTION
        USING
          MESSAGE = 'cannot quarantine public.tracked_products: public.tracked_products_legacy already exists',
          HINT = 'Review and reconcile the existing legacy table before rerunning migration 005.';
    END IF;

    ALTER TABLE public.tracked_products RENAME TO tracked_products_legacy;

    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.tracked_products_legacy'::regclass
        AND conname = 'tracked_products_pkey'
    ) THEN
      ALTER TABLE public.tracked_products_legacy
        RENAME CONSTRAINT tracked_products_pkey TO tracked_products_legacy_pkey;
    END IF;

    IF to_regclass('public.idx_tracked_products_user_status') IS NOT NULL THEN
      ALTER INDEX public.idx_tracked_products_user_status
        RENAME TO tracked_products_legacy_user_status_idx;
    END IF;

    IF to_regclass('public.tracked_products_user_status_idx') IS NOT NULL THEN
      ALTER INDEX public.tracked_products_user_status_idx
        RENAME TO tracked_products_legacy_owner_status_idx;
    END IF;

    FOR policy_record IN
      SELECT policy_name.polname
      FROM pg_policy AS policy_name
      WHERE policy_name.polrelid = 'public.tracked_products_legacy'::regclass
    LOOP
      EXECUTE format(
        'DROP POLICY %I ON public.tracked_products_legacy',
        policy_record.polname
      );
    END LOOP;

    ALTER TABLE public.tracked_products_legacy ENABLE ROW LEVEL SECURITY;
    REVOKE ALL PRIVILEGES ON TABLE public.tracked_products_legacy
      FROM PUBLIC, anon, authenticated, service_role;
    GRANT SELECT ON TABLE public.tracked_products_legacy TO service_role;

    COMMENT ON TABLE public.tracked_products_legacy IS
      'Quarantined legacy tracker and serialized pending-order rows. Ownership must be reconciled explicitly through authenticated channel linking; never copy user_id automatically.';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS public.tracked_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_url TEXT NOT NULL CONSTRAINT tracked_products_product_url_check
    CHECK (length(btrim(product_url)) > 0),
  product_name TEXT NOT NULL CONSTRAINT tracked_products_product_name_check
    CHECK (length(btrim(product_name)) > 0),
  current_price NUMERIC(12,2) NOT NULL CONSTRAINT tracked_products_current_price_check
    CHECK (current_price >= 0),
  target_price NUMERIC(12,2) NOT NULL CONSTRAINT tracked_products_target_price_check
    CHECK (target_price > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CONSTRAINT tracked_products_currency_check
    CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'active' CONSTRAINT tracked_products_status_check
    CHECK (status IN ('active', 'target_reached', 'purchased', 'cancelled')),
  last_scanned_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_channel TEXT CONSTRAINT tracked_products_source_channel_check
    CHECK (source_channel IS NULL OR source_channel IN ('telegram', 'linq', 'web')),
  source_chat_id TEXT,
  prava_session_id TEXT
);

ALTER TABLE public.tracked_products
  ADD COLUMN IF NOT EXISTS source_channel TEXT,
  ADD COLUMN IF NOT EXISTS source_chat_id TEXT,
  ADD COLUMN IF NOT EXISTS prava_session_id TEXT;

DO $migration$
DECLARE
  id_type TEXT;
  user_id_type TEXT;
  invalid_count BIGINT;
  foreign_key_record RECORD;
BEGIN
  SELECT format_type(column_record.atttypid, column_record.atttypmod)
    INTO id_type
  FROM pg_attribute AS column_record
  WHERE column_record.attrelid = 'public.tracked_products'::regclass
    AND column_record.attname = 'id'
    AND NOT column_record.attisdropped;

  SELECT format_type(column_record.atttypid, column_record.atttypmod)
    INTO user_id_type
  FROM pg_attribute AS column_record
  WHERE column_record.attrelid = 'public.tracked_products'::regclass
    AND column_record.attname = 'user_id'
    AND NOT column_record.attisdropped;

  IF id_type <> 'uuid' OR user_id_type <> 'uuid' THEN
    RAISE EXCEPTION
      'public.tracked_products must use UUID id/user_id columns after legacy quarantine (found id=%, user_id=%)',
      id_type,
      user_id_type;
  END IF;

  SELECT count(*)
    INTO invalid_count
  FROM public.tracked_products AS tracker
  LEFT JOIN auth.users AS auth_user ON auth_user.id = tracker.user_id
  WHERE tracker.user_id IS NULL
     OR auth_user.id IS NULL
     OR tracker.product_url IS NULL
     OR length(btrim(tracker.product_url)) = 0
     OR tracker.product_name IS NULL
     OR length(btrim(tracker.product_name)) = 0
     OR tracker.current_price IS NULL
     OR tracker.current_price < 0
     OR tracker.target_price IS NULL
     OR tracker.target_price <= 0
     OR tracker.currency IS NULL
     OR tracker.currency !~ '^[A-Z]{3}$'
     OR tracker.status IS NULL
     OR tracker.status NOT IN ('active', 'target_reached', 'purchased', 'cancelled')
     OR tracker.created_at IS NULL
     OR tracker.updated_at IS NULL
     OR (
       tracker.source_channel IS NOT NULL
       AND tracker.source_channel NOT IN ('telegram', 'linq', 'web')
     );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION
      USING
        MESSAGE = format('public.tracked_products has %s row(s) incompatible with the authenticated tracker schema', invalid_count),
        DETAIL = 'No tracker row was deleted or assigned to a different user.',
        HINT = 'Export and reconcile the invalid rows, then rerun migration 005.';
  END IF;

  -- Remove only user_id foreign keys that target a legacy profile table.
  FOR foreign_key_record IN
    SELECT constraint_record.conname
    FROM pg_constraint AS constraint_record
    JOIN pg_attribute AS column_record
      ON column_record.attrelid = constraint_record.conrelid
     AND column_record.attnum = ANY (constraint_record.conkey)
    WHERE constraint_record.contype = 'f'
      AND constraint_record.conrelid = 'public.tracked_products'::regclass
      AND constraint_record.confrelid <> 'auth.users'::regclass
      AND column_record.attname = 'user_id'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.tracked_products DROP CONSTRAINT %I',
      foreign_key_record.conname
    );
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    JOIN pg_attribute AS column_record
      ON column_record.attrelid = constraint_record.conrelid
     AND column_record.attnum = ANY (constraint_record.conkey)
    WHERE constraint_record.contype = 'f'
      AND constraint_record.conrelid = 'public.tracked_products'::regclass
      AND constraint_record.confrelid = 'auth.users'::regclass
      AND column_record.attname = 'user_id'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_auth_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END
$migration$;

ALTER TABLE public.tracked_products
  ALTER COLUMN id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN product_url SET NOT NULL,
  ALTER COLUMN product_name SET NOT NULL,
  ALTER COLUMN current_price TYPE NUMERIC(12,2),
  ALTER COLUMN current_price SET NOT NULL,
  ALTER COLUMN target_price TYPE NUMERIC(12,2),
  ALTER COLUMN target_price SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_product_url_check'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_product_url_check
      CHECK (length(btrim(product_url)) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_product_name_check'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_product_name_check
      CHECK (length(btrim(product_name)) > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_current_price_check'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_current_price_check
      CHECK (current_price >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_target_price_check'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_target_price_check
      CHECK (target_price > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_currency_check'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_currency_check
      CHECK (currency ~ '^[A-Z]{3}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_status_check'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_status_check
      CHECK (status IN ('active', 'target_reached', 'purchased', 'cancelled'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_source_channel_check'
  ) THEN
    ALTER TABLE public.tracked_products
      ADD CONSTRAINT tracked_products_source_channel_check
      CHECK (source_channel IS NULL OR source_channel IN ('telegram', 'linq', 'web'));
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS tracked_products_user_status_idx
  ON public.tracked_products(user_id, status);

-- ---------------------------------------------------------------------------
-- Durable purchase state and tables.
-- ---------------------------------------------------------------------------

DO $migration$
DECLARE
  actual_labels TEXT[];
  expected_labels CONSTANT TEXT[] := ARRAY[
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
    'expired'
  ]::TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type AS type_record
    JOIN pg_namespace AS namespace_record
      ON namespace_record.oid = type_record.typnamespace
    WHERE namespace_record.nspname = 'public'
      AND type_record.typname = 'purchase_state'
  ) THEN
    CREATE TYPE public.purchase_state AS ENUM (
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
      'expired'
    );
  END IF;

  SELECT array_agg(enum_value.enumlabel::TEXT ORDER BY enum_value.enumsortorder)
    INTO actual_labels
  FROM pg_enum AS enum_value
  JOIN pg_type AS type_record ON type_record.oid = enum_value.enumtypid
  JOIN pg_namespace AS namespace_record ON namespace_record.oid = type_record.typnamespace
  WHERE namespace_record.nspname = 'public'
    AND type_record.typname = 'purchase_state';

  IF actual_labels IS DISTINCT FROM expected_labels THEN
    RAISE EXCEPTION
      'public.purchase_state has unexpected labels: expected %, found %',
      expected_labels,
      actual_labels;
  END IF;
END
$migration$;

CREATE TABLE public.channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'linq')),
  provider_user_id TEXT NOT NULL CHECK (length(btrim(provider_user_id)) > 0),
  provider_chat_id TEXT NOT NULL CHECK (length(btrim(provider_chat_id)) > 0),
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id)
);

CREATE TABLE public.merchant_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('swiggy', 'zepto', 'shopify')),
  external_account_id TEXT,
  oauth_secret_ref TEXT,
  refresh_secret_ref TEXT,
  steel_profile_id TEXT,
  connection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (connection_status IN ('pending', 'active', 'expired', 'revoked')),
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE TABLE public.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('telegram', 'linq', 'web')),
  source_event_id TEXT,
  source_chat_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('food', 'grocery', 'product')),
  merchant_provider TEXT NOT NULL CHECK (merchant_provider IN ('swiggy', 'zepto', 'shopify')),
  merchant_name TEXT,
  merchant_domain TEXT,
  merchant_account_id TEXT,
  state public.purchase_state NOT NULL DEFAULT 'draft',
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quoted_total_minor BIGINT CHECK (quoted_total_minor IS NULL OR quoted_total_minor > 0),
  authorized_total_minor BIGINT CHECK (authorized_total_minor IS NULL OR authorized_total_minor > 0),
  merchant_total_minor BIGINT CHECK (merchant_total_minor IS NULL OR merchant_total_minor > 0),
  selected_address_id TEXT,
  external_order_ref TEXT UNIQUE,
  merchant_order_id TEXT,
  merchant_order_url TEXT,
  idempotency_key UUID NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE public.purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  requested_name TEXT NOT NULL CHECK (length(btrim(requested_name)) > 0),
  merchant_product_id TEXT,
  merchant_variant_id TEXT,
  resolved_name TEXT,
  unit_price_minor BIGINT CHECK (unit_price_minor IS NULL OR unit_price_minor >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  availability_status TEXT CHECK (
    availability_status IS NULL OR length(btrim(availability_status)) > 0
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.payment_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL UNIQUE REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'prava' CHECK (provider = 'prava'),
  provider_session_id TEXT NOT NULL UNIQUE CHECK (length(btrim(provider_session_id)) > 0),
  provider_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'awaiting_result', 'completed', 'failed', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  credential_issued_at TIMESTAMPTZ,
  reported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE public.checkout_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  idempotency_key UUID NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'running', 'submitted', 'unknown', 'approved', 'declined', 'failed')),
  merchant_order_id TEXT,
  processor_authorization_code TEXT,
  processor_response_code TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE(purchase_order_id, attempt_number),
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE public.transaction_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_attempt_id UUID NOT NULL UNIQUE REFERENCES public.checkout_attempts(id) ON DELETE CASCADE,
  prava_session_id TEXT NOT NULL CHECK (length(btrim(prava_session_id)) > 0),
  txn_ref_id TEXT NOT NULL CHECK (length(btrim(txn_ref_id)) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT,
  response_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.processed_events (
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  event_id TEXT NOT NULL CHECK (length(btrim(event_id)) > 0),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, event_id)
);

CREATE TABLE public.workflow_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Channel webhook jobs may be queued before a purchase intent is resolved.
  -- Once populated, the foreign key still guarantees a real durable order.
  purchase_order_id UUID REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (length(btrim(job_type)) > 0),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'retrying', 'completed', 'failed')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Foreign-key, ownership, idempotency, and worker queue access paths.
CREATE INDEX channel_identities_user_id_idx
  ON public.channel_identities(user_id);
CREATE INDEX purchase_orders_user_state_created_idx
  ON public.purchase_orders(user_id, state, created_at DESC);
CREATE UNIQUE INDEX purchase_orders_source_event_uidx
  ON public.purchase_orders(source_channel, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX purchase_orders_merchant_order_uidx
  ON public.purchase_orders(merchant_provider, merchant_order_id)
  WHERE merchant_order_id IS NOT NULL;
CREATE INDEX purchase_orders_expires_idx
  ON public.purchase_orders(expires_at)
  WHERE expires_at IS NOT NULL
    AND state NOT IN ('completed', 'declined', 'failed', 'canceled', 'expired');
CREATE INDEX purchase_items_purchase_order_id_idx
  ON public.purchase_items(purchase_order_id);
CREATE INDEX checkout_attempts_status_started_idx
  ON public.checkout_attempts(status, started_at)
  WHERE status IN ('created', 'running', 'submitted', 'unknown');
CREATE INDEX transaction_reports_retry_idx
  ON public.transaction_reports(next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX workflow_jobs_purchase_order_id_idx
  ON public.workflow_jobs(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
CREATE INDEX workflow_jobs_available_idx
  ON public.workflow_jobs(available_at, id)
  WHERE state IN ('queued', 'retrying');
CREATE INDEX workflow_jobs_lease_idx
  ON public.workflow_jobs(lease_until)
  WHERE state = 'running';

-- Bring legacy installations up to the clean baseline's foreign-key access
-- paths without changing or reassigning any legacy row.
CREATE INDEX IF NOT EXISTS alternatives_subscription_id_idx
  ON public.alternatives(subscription_id);
CREATE INDEX IF NOT EXISTS decisions_subscription_id_idx
  ON public.decisions(subscription_id);
CREATE INDEX IF NOT EXISTS decisions_alternative_id_idx
  ON public.decisions(alternative_id) WHERE alternative_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS negotiation_logs_subscription_id_idx
  ON public.negotiation_logs(subscription_id);
CREATE INDEX IF NOT EXISTS negotiation_logs_decision_id_idx
  ON public.negotiation_logs(decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scan_history_user_started_idx
  ON public.scan_history(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_sent_idx
  ON public.notifications(user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS notifications_decision_id_idx
  ON public.notifications(decision_id) WHERE decision_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS and explicit Data API privileges.
-- ---------------------------------------------------------------------------

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alternatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.negotiation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_jobs ENABLE ROW LEVEL SECURITY;

-- Recreate baseline policies so upgraded installations receive the same model
-- as clean installations. Purchases and legacy business data are client-read
-- only; mutations go through authenticated server/workflow boundaries.
DROP POLICY IF EXISTS users_select_own ON public.users;
DROP POLICY IF EXISTS users_insert_own ON public.users;
DROP POLICY IF EXISTS users_update_own ON public.users;
DROP POLICY IF EXISTS subscriptions_select_own ON public.subscriptions;
DROP POLICY IF EXISTS alternatives_select_own ON public.alternatives;
DROP POLICY IF EXISTS decisions_select_own ON public.decisions;
DROP POLICY IF EXISTS negotiation_logs_select_own ON public.negotiation_logs;
DROP POLICY IF EXISTS scan_history_select_own ON public.scan_history;
DROP POLICY IF EXISTS notifications_select_own ON public.notifications;

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

DO $migration$
DECLARE
  policy_record RECORD;
BEGIN
  FOR policy_record IN
    SELECT policy_name.polname
    FROM pg_policy AS policy_name
    WHERE policy_name.polrelid = 'public.tracked_products'::regclass
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.tracked_products',
      policy_record.polname
    );
  END LOOP;
END
$migration$;

CREATE POLICY tracked_products_select_own ON public.tracked_products
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY tracked_products_insert_own ON public.tracked_products
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY tracked_products_update_own ON public.tracked_products
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY tracked_products_delete_own ON public.tracked_products
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY channel_identities_select_own ON public.channel_identities
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY merchant_connections_select_own ON public.merchant_connections
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY purchase_orders_select_own ON public.purchase_orders
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY purchase_items_select_own ON public.purchase_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.purchase_orders AS purchase_order
    WHERE purchase_order.id = purchase_order_id
      AND purchase_order.user_id = (SELECT auth.uid())
  ));

REVOKE ALL PRIVILEGES ON TABLE
  public.users,
  public.subscriptions,
  public.alternatives,
  public.decisions,
  public.negotiation_logs,
  public.scan_history,
  public.notifications,
  public.tracked_products,
  public.channel_identities,
  public.merchant_connections,
  public.purchase_orders,
  public.purchase_items,
  public.payment_sessions,
  public.checkout_attempts,
  public.transaction_reports,
  public.processed_events,
  public.workflow_jobs
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
  public.notifications,
  public.channel_identities,
  public.purchase_orders,
  public.purchase_items
TO authenticated;
-- Tracker payment/session linkage remains server-only. Client roles receive
-- only the catalog fields needed to create and manage a price target.
GRANT SELECT (
  id,
  user_id,
  product_url,
  product_name,
  current_price,
  target_price,
  currency,
  status,
  last_scanned_at,
  created_at,
  updated_at,
  source_channel
) ON TABLE public.tracked_products TO authenticated;
GRANT INSERT (
  id,
  user_id,
  product_url,
  product_name,
  current_price,
  target_price,
  currency,
  source_channel
) ON TABLE public.tracked_products TO authenticated;
GRANT UPDATE (
  product_url,
  product_name,
  target_price,
  currency,
  updated_at
) ON TABLE public.tracked_products TO authenticated;
GRANT DELETE ON TABLE public.tracked_products TO authenticated;

-- Secret references are server-only. Authenticated users may inspect only
-- non-secret connection metadata, still restricted by owner RLS.
GRANT SELECT (
  id,
  user_id,
  provider,
  external_account_id,
  connection_status,
  scopes,
  expires_at,
  created_at,
  updated_at
) ON TABLE public.merchant_connections TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.users,
  public.subscriptions,
  public.alternatives,
  public.decisions,
  public.negotiation_logs,
  public.scan_history,
  public.notifications,
  public.tracked_products,
  public.channel_identities,
  public.merchant_connections,
  public.purchase_orders,
  public.purchase_items,
  public.payment_sessions,
  public.checkout_attempts,
  public.transaction_reports,
  public.processed_events,
  public.workflow_jobs
TO service_role;

COMMENT ON COLUMN public.merchant_connections.oauth_secret_ref IS
  'Reference to encrypted secret storage; never store or expose a raw OAuth token here.';
COMMENT ON COLUMN public.merchant_connections.refresh_secret_ref IS
  'Reference to encrypted secret storage; never store or expose a raw refresh token here.';
COMMENT ON TABLE public.payment_sessions IS
  'Service-only session metadata. Network tokens, dynamic CVVs, and cryptograms are forbidden.';
COMMENT ON TABLE public.checkout_attempts IS
  'Service-only, idempotent merchant execution attempts.';
COMMENT ON TABLE public.transaction_reports IS
  'Service-only Prava reporting state; retries must not rerun merchant checkout.';
COMMENT ON TABLE public.processed_events IS
  'Service-only webhook/event deduplication ledger.';
COMMENT ON TABLE public.workflow_jobs IS
  'Service-only durable workflow queue. Workers should claim jobs with FOR UPDATE SKIP LOCKED.';

COMMIT;
