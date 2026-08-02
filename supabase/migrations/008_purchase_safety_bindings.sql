-- Bind execution to one exact, unexpired Prava approval and make webhook
-- deduplication + enqueue atomic. Service-role workflows are the only callers.

BEGIN;

ALTER TABLE public.purchase_orders
  ADD COLUMN merchant_country_code CHAR(2)
    CHECK (merchant_country_code IS NULL OR merchant_country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN merchant_category_code VARCHAR(4)
    CHECK (merchant_category_code IS NULL OR merchant_category_code ~ '^\d{4}$'),
  ADD COLUMN merchant_category TEXT
    CHECK (merchant_category IS NULL OR length(btrim(merchant_category)) BETWEEN 1 AND 100);

ALTER TABLE public.payment_sessions
  ADD COLUMN amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor > 0),
  ADD COLUMN currency CHAR(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');

ALTER TABLE public.checkout_attempts
  ADD COLUMN payment_session_id UUID
    REFERENCES public.payment_sessions(id) ON DELETE RESTRICT;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.checkout_attempts AS attempt
    LEFT JOIN public.payment_sessions AS session
      ON session.purchase_order_id = attempt.purchase_order_id
    WHERE session.id IS NULL
  ) THEN
    RAISE EXCEPTION
      USING
        MESSAGE = 'cannot bind checkout attempts to payment sessions',
        HINT = 'Reconcile legacy attempts to their exact Prava session before applying migration 008.';
  END IF;

  UPDATE public.checkout_attempts AS attempt
  SET payment_session_id = session.id
  FROM public.payment_sessions AS session
  WHERE session.purchase_order_id = attempt.purchase_order_id
    AND attempt.payment_session_id IS NULL;
END
$migration$;

ALTER TABLE public.checkout_attempts
  ALTER COLUMN payment_session_id SET NOT NULL,
  ADD CONSTRAINT checkout_attempts_payment_session_key UNIQUE (payment_session_id);

ALTER TABLE public.transaction_reports
  DROP CONSTRAINT transaction_reports_status_check,
  ADD CONSTRAINT transaction_reports_status_check
    CHECK (status IN ('pending', 'reporting', 'confirmed', 'failed')),
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD CONSTRAINT transaction_reports_txn_ref_key UNIQUE (txn_ref_id);

ALTER TABLE public.workflow_jobs
  ADD CONSTRAINT workflow_jobs_purchase_scope_check CHECK (
    purchase_order_id IS NOT NULL OR job_type = 'process_channel_message'
  ),
  ADD CONSTRAINT workflow_jobs_payload_size_check CHECK (
    octet_length(payload::TEXT) <= 65536
  );

CREATE TABLE public.payment_callback_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL UNIQUE
    REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

ALTER TABLE public.payment_callback_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.payment_callback_states
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_callback_states
  TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_transaction_report_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  bound_session_id TEXT;
BEGIN
  SELECT session.provider_session_id
    INTO bound_session_id
  FROM public.checkout_attempts AS attempt
  JOIN public.payment_sessions AS session
    ON session.id = attempt.payment_session_id
  WHERE attempt.id = NEW.checkout_attempt_id;

  IF bound_session_id IS NULL OR bound_session_id IS DISTINCT FROM NEW.prava_session_id THEN
    RAISE EXCEPTION 'transaction report does not match the claimed payment session';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS transaction_reports_session_binding
  ON public.transaction_reports;
CREATE TRIGGER transaction_reports_session_binding
  BEFORE INSERT OR UPDATE OF checkout_attempt_id, prava_session_id
  ON public.transaction_reports
  FOR EACH ROW EXECUTE FUNCTION public.enforce_transaction_report_session();

REVOKE ALL ON FUNCTION public.enforce_transaction_report_session()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_purchase_execution(
  p_purchase_order_id UUID,
  p_expected_version INTEGER,
  p_attempt_id UUID
)
RETURNS TABLE (
  claimed BOOLEAN,
  checkout_attempt_id UUID,
  purchase_version INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  claimed_order public.purchase_orders%ROWTYPE;
  claimed_session public.payment_sessions%ROWTYPE;
  next_attempt INTEGER;
BEGIN
  SELECT *
    INTO claimed_order
  FROM public.purchase_orders
  WHERE id = p_purchase_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF claimed_order.state <> 'credential_ready'
     OR claimed_order.version <> p_expected_version
     OR claimed_order.expires_at IS NULL
     OR claimed_order.expires_at <= now()
     OR claimed_order.quoted_total_minor IS NULL
     OR claimed_order.authorized_total_minor IS NULL
     OR claimed_order.quoted_total_minor <> claimed_order.authorized_total_minor THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, claimed_order.version;
    RETURN;
  END IF;

  SELECT *
    INTO claimed_session
  FROM public.payment_sessions
  WHERE purchase_order_id = claimed_order.id
  FOR UPDATE;

  IF NOT FOUND
     OR claimed_session.status <> 'awaiting_result'
     OR claimed_session.credential_issued_at IS NULL
     OR claimed_session.expires_at <= now()
     OR claimed_session.amount_minor IS DISTINCT FROM claimed_order.authorized_total_minor
     OR claimed_session.currency IS DISTINCT FROM claimed_order.currency THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, claimed_order.version;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(attempt.attempt_number), 0) + 1
    INTO next_attempt
  FROM public.checkout_attempts AS attempt
  WHERE attempt.purchase_order_id = claimed_order.id;

  UPDATE public.payment_sessions
  SET status = 'processing', updated_at = now()
  WHERE id = claimed_session.id;

  UPDATE public.purchase_orders
  SET state = 'executing', version = version + 1, updated_at = now()
  WHERE id = claimed_order.id;

  INSERT INTO public.checkout_attempts (
    id,
    purchase_order_id,
    payment_session_id,
    attempt_number,
    idempotency_key,
    provider,
    status,
    amount_minor,
    started_at
  ) VALUES (
    p_attempt_id,
    claimed_order.id,
    claimed_session.id,
    next_attempt,
    claimed_order.idempotency_key,
    claimed_order.merchant_provider,
    'running',
    claimed_order.authorized_total_minor,
    now()
  );

  RETURN QUERY SELECT TRUE, p_attempt_id, claimed_order.version + 1;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_purchase_execution(UUID, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_purchase_execution(UUID, INTEGER, UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_and_enqueue_channel_event(
  p_provider TEXT,
  p_event_id TEXT,
  p_user_id UUID,
  p_provider_user_id TEXT,
  p_chat_id TEXT,
  p_text TEXT
)
RETURNS TABLE (
  claimed BOOLEAN,
  workflow_job_id UUID
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  inserted_event_id TEXT;
  new_job_id UUID := gen_random_uuid();
BEGIN
  IF p_provider NOT IN ('telegram', 'linq')
     OR length(p_event_id) = 0
     OR length(p_text) = 0
     OR octet_length(p_text) > 32768 THEN
    RAISE EXCEPTION 'invalid channel event';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.channel_identities AS identity
    WHERE identity.user_id = p_user_id
      AND identity.provider = p_provider
      AND identity.provider_user_id = p_provider_user_id
      AND identity.provider_chat_id = p_chat_id
      AND identity.verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'channel identity mismatch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.processed_events (provider, event_id)
  VALUES (p_provider, p_event_id)
  ON CONFLICT DO NOTHING
  RETURNING event_id INTO inserted_event_id;

  IF inserted_event_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.workflow_jobs (
    id,
    purchase_order_id,
    job_type,
    state,
    payload
  ) VALUES (
    new_job_id,
    NULL,
    'process_channel_message',
    'queued',
    jsonb_build_object(
      'provider', p_provider,
      'eventId', p_event_id,
      'userId', p_user_id,
      'providerUserId', p_provider_user_id,
      'chatId', p_chat_id,
      'text', p_text
    )
  );

  RETURN QUERY SELECT TRUE, new_job_id;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_and_enqueue_channel_event(TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_and_enqueue_channel_event(TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.claim_purchase_execution(UUID, INTEGER, UUID) IS
  'Claim one exact, unexpired Prava-approved order and create its sole checkout attempt atomically.';
COMMENT ON FUNCTION public.claim_and_enqueue_channel_event(TEXT, TEXT, UUID, TEXT, TEXT, TEXT) IS
  'Verify channel ownership, deduplicate the event, and enqueue one job in a single transaction.';
COMMENT ON TABLE public.payment_callback_states IS
  'One-time hashed browser-return tokens. A callback only queues polling; it never executes checkout.';

CREATE OR REPLACE FUNCTION public.request_prava_session(
  p_purchase_order_id UUID,
  p_user_id UUID,
  p_expected_version INTEGER
)
RETURNS TABLE (
  accepted BOOLEAN,
  workflow_job_id UUID,
  purchase_version INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  purchase_record public.purchase_orders%ROWTYPE;
  item_total BIGINT;
  new_job_id UUID := gen_random_uuid();
BEGIN
  SELECT * INTO purchase_record
  FROM public.purchase_orders
  WHERE id = p_purchase_order_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT COALESCE(sum(item.unit_price_minor * item.quantity), 0)
    INTO item_total
  FROM public.purchase_items AS item
  WHERE item.purchase_order_id = purchase_record.id;

  IF purchase_record.state <> 'quoted'
     OR purchase_record.version <> p_expected_version
     OR purchase_record.expires_at IS NULL
     OR purchase_record.expires_at <= now()
     OR purchase_record.quoted_total_minor IS NULL
     OR purchase_record.authorized_total_minor IS NULL
     OR purchase_record.quoted_total_minor <> purchase_record.authorized_total_minor
     OR item_total <> purchase_record.authorized_total_minor
     OR purchase_record.external_order_ref IS NULL
     OR purchase_record.merchant_name IS NULL
     OR purchase_record.merchant_domain IS NULL
     OR purchase_record.merchant_country_code IS NULL
     OR purchase_record.merchant_category_code IS NULL
     OR purchase_record.merchant_category IS NULL
     OR EXISTS (
       SELECT 1 FROM public.payment_sessions AS session
       WHERE session.purchase_order_id = purchase_record.id
     ) THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, purchase_record.version;
    RETURN;
  END IF;

  UPDATE public.purchase_orders
  SET state = 'awaiting_payment_approval',
      version = version + 1,
      updated_at = now()
  WHERE id = purchase_record.id;

  INSERT INTO public.workflow_jobs (
    id,
    purchase_order_id,
    job_type,
    state,
    payload
  ) VALUES (
    new_job_id,
    purchase_record.id,
    'create_prava_session',
    'queued',
    '{}'::JSONB
  );

  RETURN QUERY SELECT TRUE, new_job_id, purchase_record.version + 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.consume_prava_callback(p_token_hash TEXT)
RETURNS TABLE (
  consumed BOOLEAN,
  purchase_order_id UUID,
  workflow_job_id UUID
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  callback_record public.payment_callback_states%ROWTYPE;
  new_job_id UUID := gen_random_uuid();
BEGIN
  UPDATE public.payment_callback_states
  SET consumed_at = now()
  WHERE token_hash = p_token_hash
    AND consumed_at IS NULL
    AND expires_at > now()
  RETURNING * INTO callback_record;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.workflow_jobs (
    id,
    purchase_order_id,
    job_type,
    state,
    payload
  ) VALUES (
    new_job_id,
    callback_record.purchase_order_id,
    'poll_prava_approval',
    'queued',
    '{}'::JSONB
  );

  RETURN QUERY SELECT TRUE, callback_record.purchase_order_id, new_job_id;
END
$function$;

REVOKE ALL ON FUNCTION public.request_prava_session(UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_prava_callback(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_prava_session(UUID, UUID, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_prava_callback(TEXT)
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_transaction_report(
  p_report_id UUID,
  p_lease_token UUID,
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS TABLE (
  claimed BOOLEAN,
  attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  report_record public.transaction_reports%ROWTYPE;
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 120 THEN
    RAISE EXCEPTION 'invalid report lease';
  END IF;

  UPDATE public.transaction_reports
  SET status = 'reporting',
      attempt_count = attempt_count + 1,
      lease_token = p_lease_token,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      next_attempt_at = NULL,
      updated_at = now()
  WHERE id = p_report_id
    AND (
      status IN ('pending', 'failed')
      OR (status = 'reporting' AND lease_until < now())
    )
  RETURNING * INTO report_record;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::INTEGER;
    RETURN;
  END IF;
  RETURN QUERY SELECT TRUE, report_record.attempt_count;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_transaction_report(UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_transaction_report(UUID, UUID, INTEGER)
  TO service_role;

COMMIT;
