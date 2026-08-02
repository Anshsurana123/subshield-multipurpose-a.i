-- Provision application profiles from Supabase Auth and make tracker mutations
-- service/API-only. This migration is intentionally safe to run more than once.

BEGIN;

CREATE SCHEMA IF NOT EXISTS prava_private;
REVOKE ALL ON SCHEMA prava_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION prava_private.provision_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  profile_email TEXT;
BEGIN
  -- Never let a conflicting legacy profile email abort Auth user creation.
  -- Existing profile values win; this function never touches service-owned
  -- browser context or push-subscription columns.
  SELECT CASE
    WHEN NEW.email IS NULL OR EXISTS (
      SELECT 1
      FROM public.users AS existing_profile
      WHERE existing_profile.email = NEW.email
        AND existing_profile.id <> NEW.id
    ) THEN NULL
    ELSE NEW.email
  END
  INTO profile_email;

  INSERT INTO public.users AS profile (
    id,
    email,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    profile_email,
    COALESCE(NEW.created_at, now()),
    COALESCE(NEW.updated_at, NEW.created_at, now())
  )
  ON CONFLICT (id) DO UPDATE
  SET email = COALESCE(profile.email, EXCLUDED.email),
      updated_at = CASE
        WHEN profile.email IS NULL AND EXCLUDED.email IS NOT NULL
          THEN COALESCE(
            GREATEST(profile.updated_at, EXCLUDED.updated_at),
            profile.updated_at,
            EXCLUDED.updated_at,
            now()
          )
        ELSE profile.updated_at
      END;

  RETURN NEW;
EXCEPTION
  WHEN unique_violation THEN
    -- A concurrent email claim must not prevent the Auth account itself from
    -- being created. Provision the identity without copying the conflicted
    -- email; an operator can reconcile the legacy profile later.
    INSERT INTO public.users (id, email, created_at, updated_at)
    VALUES (
      NEW.id,
      NULL,
      COALESCE(NEW.created_at, now()),
      COALESCE(NEW.updated_at, NEW.created_at, now())
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END
$function$;

ALTER FUNCTION prava_private.provision_user_profile() OWNER TO postgres;
REVOKE ALL ON FUNCTION prava_private.provision_user_profile()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS prava_provision_public_user ON auth.users;
CREATE TRIGGER prava_provision_public_user
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION prava_private.provision_user_profile();

-- Backfill Auth identities that predate the trigger. Preserve every existing
-- profile email and all service-owned profile fields. Duplicate legacy email
-- ownership is never inferred: a missing profile is provisioned with NULL.
WITH auth_profiles AS (
  SELECT
    auth_user.id,
    auth_user.email,
    auth_user.created_at,
    auth_user.updated_at,
    count(*) OVER (PARTITION BY auth_user.email) AS matching_email_count
  FROM auth.users AS auth_user
), safe_auth_profiles AS (
  SELECT
    auth_profile.id,
    CASE
      WHEN auth_profile.email IS NULL
        OR auth_profile.matching_email_count <> 1
        OR EXISTS (
          SELECT 1
          FROM public.users AS existing_profile
          WHERE existing_profile.email = auth_profile.email
            AND existing_profile.id <> auth_profile.id
        )
      THEN NULL
      ELSE auth_profile.email
    END AS email,
    COALESCE(auth_profile.created_at, now()) AS created_at,
    COALESCE(
      auth_profile.updated_at,
      auth_profile.created_at,
      now()
    ) AS updated_at
  FROM auth_profiles AS auth_profile
)
INSERT INTO public.users AS profile (id, email, created_at, updated_at)
SELECT id, email, created_at, updated_at
FROM safe_auth_profiles
ON CONFLICT (id) DO UPDATE
SET email = COALESCE(profile.email, EXCLUDED.email),
    updated_at = CASE
      WHEN profile.email IS NULL AND EXCLUDED.email IS NOT NULL
        THEN COALESCE(
          GREATEST(profile.updated_at, EXCLUDED.updated_at),
          profile.updated_at,
          EXCLUDED.updated_at,
          now()
        )
      ELSE profile.updated_at
    END;

-- Profiles are client-readable only through the owner policy. Creation and all
-- mutations are performed by the Auth trigger or service-role application APIs.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_select_own ON public.users;
DROP POLICY IF EXISTS users_insert_own ON public.users;
DROP POLICY IF EXISTS users_update_own ON public.users;
DROP POLICY IF EXISTS users_delete_own ON public.users;
CREATE POLICY users_select_own ON public.users
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = id);

REVOKE ALL PRIVILEGES ON TABLE public.users
  FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, email, created_at, updated_at)
  ON TABLE public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.users TO service_role;

-- Tracked-product writes include URL validation, scrape results, workflow
-- scheduling, and outbox creation, so every mutation must cross an API/service
-- boundary. Signed-in users retain owner-scoped, non-sensitive reads only.
ALTER TABLE public.tracked_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tracked_products_select_own ON public.tracked_products;
DROP POLICY IF EXISTS tracked_products_insert_own ON public.tracked_products;
DROP POLICY IF EXISTS tracked_products_update_own ON public.tracked_products;
DROP POLICY IF EXISTS tracked_products_delete_own ON public.tracked_products;
CREATE POLICY tracked_products_select_own ON public.tracked_products
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL PRIVILEGES ON TABLE public.tracked_products
  FROM PUBLIC, anon, authenticated;
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
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.tracked_products TO service_role;

-- A durable, bounded reservation ledger prevents expensive scrape work from
-- starting when a user is over either enrollment limit. Reservations expire so
-- a crashed request cannot hold tracker capacity indefinitely.
CREATE TABLE IF NOT EXISTS public.tracker_enrollment_reservations (
  request_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  accepted BOOLEAN NOT NULL,
  decision_reason TEXT NOT NULL
    CHECK (decision_reason IN ('reserved', 'quota_exceeded')),
  reserved_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (accepted = (decision_reason = 'reserved')),
  CHECK (
    (accepted AND reserved_until IS NOT NULL AND reserved_until > created_at)
    OR (NOT accepted AND reserved_until IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS tracker_enrollment_reservations_user_created_idx
  ON public.tracker_enrollment_reservations(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tracker_enrollment_reservations_pending_idx
  ON public.tracker_enrollment_reservations(user_id, reserved_until)
  WHERE accepted;

ALTER TABLE public.tracker_enrollment_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.tracker_enrollment_reservations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.tracker_enrollment_reservations TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_tracker_enrollment(
  p_user_id UUID,
  p_request_id UUID
)
RETURNS TABLE (
  accepted BOOLEAN,
  reason TEXT,
  reservation_id UUID,
  reserved_until TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  existing_reservation public.tracker_enrollment_reservations%ROWTYPE;
  attempts_in_window BIGINT;
  capacity_in_use BIGINT;
  reservation_expires_at TIMESTAMPTZ := now() + interval '15 minutes';
BEGIN
  IF p_user_id IS NULL OR p_request_id IS NULL THEN
    RETURN QUERY
      SELECT FALSE, 'invalid_request'::TEXT, p_request_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Advisory locking makes the rate and capacity counts one atomic decision for
  -- concurrent requests belonging to the same authenticated user.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::TEXT, 718291)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::TEXT, 718292)
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.users AS profile WHERE profile.id = p_user_id
  ) THEN
    RETURN QUERY
      SELECT FALSE, 'user_not_found'::TEXT, p_request_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- The ledger is operational rate-limit state, not a financial audit log.
  -- Removing only entries older than one day cannot weaken the one-hour limit.
  DELETE FROM public.tracker_enrollment_reservations AS stale_reservation
  WHERE stale_reservation.user_id = p_user_id
    AND stale_reservation.created_at < now() - interval '24 hours';

  SELECT reservation.*
    INTO existing_reservation
  FROM public.tracker_enrollment_reservations AS reservation
  WHERE reservation.request_id = p_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF existing_reservation.user_id <> p_user_id THEN
      RETURN QUERY
        SELECT FALSE, 'request_conflict'::TEXT, p_request_id, NULL::TIMESTAMPTZ;
    ELSIF NOT existing_reservation.accepted THEN
      RETURN QUERY
        SELECT FALSE, existing_reservation.decision_reason,
               existing_reservation.request_id, NULL::TIMESTAMPTZ;
    ELSIF EXISTS (
      SELECT 1
      FROM public.tracked_products AS tracked_product
      WHERE tracked_product.id = existing_reservation.request_id
        AND tracked_product.user_id = p_user_id
    ) THEN
      RETURN QUERY
        SELECT FALSE, 'already_enrolled'::TEXT,
               existing_reservation.request_id,
               existing_reservation.reserved_until;
    ELSIF existing_reservation.reserved_until <= now() THEN
      RETURN QUERY
        SELECT FALSE, 'reservation_expired'::TEXT,
               existing_reservation.request_id,
               existing_reservation.reserved_until;
    ELSE
      RETURN QUERY
        SELECT TRUE, 'reserved'::TEXT,
               existing_reservation.request_id,
               existing_reservation.reserved_until;
    END IF;
    RETURN;
  END IF;

  SELECT count(*)
    INTO attempts_in_window
  FROM public.tracker_enrollment_reservations AS recent_attempt
  WHERE recent_attempt.user_id = p_user_id
    AND recent_attempt.created_at > now() - interval '1 hour';

  IF attempts_in_window >= 5 THEN
    -- Do not add unbounded denial rows once the durable window is full.
    RETURN QUERY
      SELECT FALSE, 'rate_limited'::TEXT, p_request_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT
    (
      SELECT count(*)
      FROM public.tracked_products AS tracked_product
      WHERE tracked_product.user_id = p_user_id
        AND tracked_product.status = 'active'
    ) + (
      SELECT count(*)
      FROM public.tracker_enrollment_reservations AS pending_reservation
      WHERE pending_reservation.user_id = p_user_id
        AND pending_reservation.accepted
        AND pending_reservation.reserved_until > now()
        AND NOT EXISTS (
          SELECT 1
          FROM public.tracked_products AS reserved_product
          WHERE reserved_product.id = pending_reservation.request_id
            AND reserved_product.user_id = pending_reservation.user_id
            AND reserved_product.status = 'active'
        )
    )
  INTO capacity_in_use;

  IF capacity_in_use >= 25 THEN
    INSERT INTO public.tracker_enrollment_reservations (
      request_id,
      user_id,
      accepted,
      decision_reason,
      reserved_until
    ) VALUES (
      p_request_id,
      p_user_id,
      FALSE,
      'quota_exceeded',
      NULL
    );

    RETURN QUERY
      SELECT FALSE, 'quota_exceeded'::TEXT, p_request_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO public.tracker_enrollment_reservations (
    request_id,
    user_id,
    accepted,
    decision_reason,
    reserved_until
  ) VALUES (
    p_request_id,
    p_user_id,
    TRUE,
    'reserved',
    reservation_expires_at
  );

  RETURN QUERY
    SELECT TRUE, 'reserved'::TEXT, p_request_id, reservation_expires_at;
END
$function$;

REVOKE ALL ON FUNCTION public.reserve_tracker_enrollment(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_tracker_enrollment(UUID, UUID)
  TO service_role;

COMMENT ON FUNCTION prava_private.provision_user_profile() IS
  'Internal Auth trigger: provisions public.users without exposing or replacing service-owned browser context.';
COMMENT ON TABLE public.tracked_products IS
  'Owner-readable price targets; all mutations must use authenticated application APIs backed by the service role.';
COMMENT ON TABLE public.tracker_enrollment_reservations IS
  'Service-only one-hour enrollment rate ledger and short-lived tracker-capacity reservations.';
COMMENT ON FUNCTION public.reserve_tracker_enrollment(UUID, UUID) IS
  'Atomically reserves one of 25 active tracker slots and one of 5 hourly enrollment attempts before external scraping.';

COMMIT;
