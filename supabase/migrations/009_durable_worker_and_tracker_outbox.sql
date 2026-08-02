-- Durable worker leasing and an atomic tracker target-alert outbox.

BEGIN;

ALTER TABLE public.tracked_products
  ADD COLUMN source_event_id TEXT,
  ADD COLUMN next_scan_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN scan_lease_until TIMESTAMPTZ,
  ADD COLUMN scan_lease_token UUID;

CREATE UNIQUE INDEX tracked_products_source_event_uidx
  ON public.tracked_products(source_channel, source_event_id)
  WHERE source_channel IS NOT NULL AND source_event_id IS NOT NULL;

ALTER TABLE public.notifications
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued', 'delivered', 'failed', 'unavailable')),
  ADD COLUMN delivery_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (delivery_attempt_count >= 0),
  ADD COLUMN last_delivery_error_code TEXT;

ALTER TABLE public.workflow_jobs
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN lease_token UUID,
  DROP CONSTRAINT workflow_jobs_purchase_scope_check,
  ADD CONSTRAINT workflow_jobs_purchase_scope_check CHECK (
    purchase_order_id IS NOT NULL
    OR job_type IN (
      'process_channel_message',
      'send_tracker_chat_alert',
      'send_push_notification'
    )
  );

CREATE OR REPLACE FUNCTION public.claim_tracker_target(
  p_product_id UUID,
  p_user_id UUID,
  p_current_price NUMERIC,
  p_currency TEXT,
  p_product_name TEXT,
  p_title TEXT,
  p_body TEXT
)
RETURNS TABLE (
  claimed BOOLEAN,
  workflow_job_id UUID,
  notification_id UUID
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  product_record public.tracked_products%ROWTYPE;
  new_job_id UUID := gen_random_uuid();
  new_notification_id UUID := gen_random_uuid();
BEGIN
  UPDATE public.tracked_products
  SET current_price = p_current_price,
      currency = p_currency,
      product_name = p_product_name,
      status = 'target_reached',
      last_scanned_at = now(),
      updated_at = now()
  WHERE id = p_product_id
    AND user_id = p_user_id
    AND status = 'active'
    AND p_current_price > 0
    AND p_currency ~ '^[A-Z]{3}$'
  RETURNING * INTO product_record;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.notifications (
    id,
    user_id,
    title,
    body,
    type,
    sent_at,
    delivery_status
  ) VALUES (
    new_notification_id,
    p_user_id,
    p_title,
    p_body,
    'switch_suggestion',
    now(),
    'queued'
  );

  INSERT INTO public.workflow_jobs (
    id,
    purchase_order_id,
    job_type,
    state,
    payload
  ) VALUES (
    new_job_id,
    NULL,
    'send_push_notification',
    'queued',
    jsonb_build_object(
      'notificationId', new_notification_id,
      'userId', p_user_id,
      'title', p_title,
      'body', p_body
    )
  );

  IF product_record.source_channel IS NOT NULL AND product_record.source_chat_id IS NOT NULL THEN
    INSERT INTO public.workflow_jobs (
      id,
      purchase_order_id,
      job_type,
      state,
      payload
    ) VALUES (
      gen_random_uuid(),
      NULL,
      'send_tracker_chat_alert',
      'queued',
      jsonb_build_object(
        'channel', product_record.source_channel,
        'chatId', product_record.source_chat_id,
        'title', p_title,
        'body', p_body
      )
    );
  END IF;

  RETURN QUERY SELECT TRUE, new_job_id, new_notification_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_workflow_job(
  p_job_types TEXT[],
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS TABLE (
  id UUID,
  purchase_order_id UUID,
  job_type TEXT,
  payload JSONB,
  attempt_count INTEGER,
  lease_token UUID
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_lease_seconds < 10 OR p_lease_seconds > 300 OR cardinality(p_job_types) = 0 THEN
    RAISE EXCEPTION 'invalid workflow lease request';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT job.id
    FROM public.workflow_jobs AS job
    WHERE job.job_type = ANY(p_job_types)
      AND job.available_at <= now()
      AND (
        job.state IN ('queued', 'retrying')
        OR (job.state = 'running' AND job.lease_until < now())
      )
    ORDER BY job.available_at, job.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed_job AS (
    UPDATE public.workflow_jobs AS job
    SET state = 'running',
        lease_until = now() + make_interval(secs => p_lease_seconds),
        attempt_count = job.attempt_count + 1,
        last_error_code = NULL,
        lease_token = gen_random_uuid(),
        updated_at = now()
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.*
  )
  SELECT claimed_job.id,
         claimed_job.purchase_order_id,
         claimed_job.job_type,
         claimed_job.payload,
         claimed_job.attempt_count,
         claimed_job.lease_token
  FROM claimed_job;
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_workflow_job(
  p_job_id UUID,
  p_lease_token UUID,
  p_succeeded BOOLEAN,
  p_retryable BOOLEAN,
  p_error_code TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  changed_count INTEGER;
BEGIN
  UPDATE public.workflow_jobs AS job
  SET state = CASE
        WHEN p_succeeded THEN 'completed'
        WHEN p_retryable AND job.attempt_count < 5 THEN 'retrying'
        ELSE 'failed'
      END,
      available_at = CASE
        WHEN NOT p_succeeded AND p_retryable AND job.attempt_count < 5
          THEN now() + make_interval(secs => LEAST(300, 5 * (2 ^ job.attempt_count)::INTEGER))
        ELSE job.available_at
      END,
      lease_until = NULL,
      lease_token = NULL,
      last_error_code = CASE WHEN p_succeeded THEN NULL ELSE left(p_error_code, 100) END,
      payload = CASE WHEN p_succeeded THEN '{}'::JSONB ELSE job.payload END,
      updated_at = now()
  WHERE job.id = p_job_id
    AND job.state = 'running'
    AND job.lease_token = p_lease_token;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_tracked_product_scan(
  p_lease_seconds INTEGER DEFAULT 240
)
RETURNS SETOF public.tracked_products
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid tracker scan lease';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT product.id
    FROM public.tracked_products AS product
    WHERE product.status = 'active'
      AND product.next_scan_at <= now()
      AND (product.scan_lease_until IS NULL OR product.scan_lease_until < now())
    ORDER BY product.next_scan_at, product.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.tracked_products AS product
  SET scan_lease_until = now() + make_interval(secs => p_lease_seconds),
      scan_lease_token = gen_random_uuid(),
      updated_at = now()
  FROM candidate
  WHERE product.id = candidate.id
  RETURNING product.*;
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_tracked_product_scan(
  p_product_id UUID,
  p_lease_token UUID,
  p_succeeded BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  changed_count INTEGER;
BEGIN
  UPDATE public.tracked_products
  SET scan_lease_until = NULL,
      scan_lease_token = NULL,
      next_scan_at = now() + CASE
        WHEN p_succeeded THEN interval '1 hour'
        ELSE interval '10 minutes'
      END,
      updated_at = now()
  WHERE id = p_product_id
    AND scan_lease_until IS NOT NULL
    AND scan_lease_token = p_lease_token;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_tracker_target(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_workflow_job(TEXT[], INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_workflow_job(UUID, UUID, BOOLEAN, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_tracked_product_scan(INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_tracked_product_scan(UUID, UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tracker_target(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_workflow_job(TEXT[], INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_workflow_job(UUID, UUID, BOOLEAN, BOOLEAN, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_tracked_product_scan(INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_tracked_product_scan(UUID, UUID, BOOLEAN)
  TO service_role;

COMMENT ON COLUMN public.tracked_products.source_event_id IS
  'Service-only provider event key used to make channel retries idempotent.';
COMMENT ON FUNCTION public.claim_tracker_target(UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT) IS
  'Atomically records a target hit, persists the user notification, and enqueues its delivery.';

COMMIT;
