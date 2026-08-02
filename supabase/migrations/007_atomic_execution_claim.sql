-- Migration 007: atomically claim merchant execution and create its one durable attempt.
-- Only the service role may call this SECURITY INVOKER function.

BEGIN;

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
  next_attempt INTEGER;
BEGIN
  UPDATE public.purchase_orders
  SET state = 'executing',
      version = version + 1,
      updated_at = now()
  WHERE id = p_purchase_order_id
    AND state = 'credential_ready'
    AND version = p_expected_version
    AND authorized_total_minor IS NOT NULL
  RETURNING * INTO claimed_order;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT FALSE, NULL::UUID, current_order.version
      FROM public.purchase_orders AS current_order
      WHERE current_order.id = p_purchase_order_id;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(attempt.attempt_number), 0) + 1
    INTO next_attempt
  FROM public.checkout_attempts AS attempt
  WHERE attempt.purchase_order_id = claimed_order.id;

  INSERT INTO public.checkout_attempts (
    id,
    purchase_order_id,
    attempt_number,
    idempotency_key,
    provider,
    status,
    amount_minor,
    started_at
  ) VALUES (
    p_attempt_id,
    claimed_order.id,
    next_attempt,
    claimed_order.idempotency_key,
    claimed_order.merchant_provider,
    'running',
    claimed_order.authorized_total_minor,
    now()
  );

  RETURN QUERY SELECT TRUE, p_attempt_id, claimed_order.version;
END
$function$;

REVOKE ALL ON FUNCTION public.claim_purchase_execution(UUID, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_purchase_execution(UUID, INTEGER, UUID)
  TO service_role;

COMMENT ON FUNCTION public.claim_purchase_execution(UUID, INTEGER, UUID) IS
  'CAS credential_ready -> executing and create exactly one merchant checkout attempt in the same transaction.';

COMMIT;
