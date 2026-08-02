BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

SELECT plan(35);

SELECT ok(
  to_regprocedure('prava_private.provision_user_profile()') IS NOT NULL,
  'the internal Auth profile provisioning function exists'
);
SELECT ok(
  (
    SELECT function_record.prosecdef
      AND pg_get_userbyid(function_record.proowner) = 'postgres'
    FROM pg_proc AS function_record
    WHERE function_record.oid = to_regprocedure('prava_private.provision_user_profile()')
  ),
  'the Auth trigger function is security definer owned by postgres'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_record
    WHERE trigger_record.tgrelid = 'auth.users'::regclass
      AND trigger_record.tgname = 'prava_provision_public_user'
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgenabled <> 'D'
      AND trigger_record.tgfoid = to_regprocedure('prava_private.provision_user_profile()')
  ),
  'auth.users has the enabled PRAVA profile trigger'
);
SELECT ok(
  NOT has_function_privilege(
    'public',
    'prava_private.provision_user_profile()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'prava_private.provision_user_profile()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'prava_private.provision_user_profile()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role',
    'prava_private.provision_user_profile()',
    'EXECUTE'
  ),
  'the trigger-only profile function is not directly executable by API roles'
);
SELECT is(
  (
    SELECT count(*)
    FROM auth.users AS auth_user
    LEFT JOIN public.users AS profile ON profile.id = auth_user.id
    WHERE profile.id IS NULL
  ),
  0::BIGINT,
  'all existing Auth users were backfilled into public.users'
);
SELECT ok(
  position(
    'browserbase_context_id'
    IN pg_get_functiondef(to_regprocedure('prava_private.provision_user_profile()'))
  ) = 0,
  'the Auth trigger cannot write service-owned browser context'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_policy
    WHERE polrelid = 'public.users'::regclass
  ),
  1::BIGINT,
  'profiles retain one owner-scoped read policy'
);
SELECT ok(
  has_column_privilege('authenticated', 'public.users', 'id', 'SELECT'),
  'authenticated users may read safe profile identity metadata'
);
SELECT ok(
  NOT has_column_privilege(
    'authenticated',
    'public.users',
    'browserbase_context_id',
    'SELECT'
  ),
  'authenticated users cannot read browser context IDs'
);
SELECT ok(
  NOT has_any_column_privilege('authenticated', 'public.users', 'INSERT'),
  'authenticated users cannot insert profiles directly'
);
SELECT ok(
  NOT has_any_column_privilege('authenticated', 'public.users', 'UPDATE'),
  'authenticated users cannot update profiles directly'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.users', 'DELETE'),
  'authenticated users cannot delete profiles directly'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_policy
    WHERE polrelid = 'public.tracked_products'::regclass
  ),
  1::BIGINT,
  'tracked products retain one owner-scoped read policy'
);
SELECT ok(
  has_column_privilege('authenticated', 'public.tracked_products', 'id', 'SELECT'),
  'authenticated users may read safe tracker metadata'
);
SELECT ok(
  NOT has_column_privilege(
    'authenticated',
    'public.tracked_products',
    'source_chat_id',
    'SELECT'
  ),
  'authenticated users cannot read private tracker chat linkage'
);
SELECT ok(
  NOT has_any_column_privilege(
    'authenticated',
    'public.tracked_products',
    'INSERT'
  ),
  'authenticated users cannot insert tracked products directly'
);
SELECT ok(
  NOT has_any_column_privilege(
    'authenticated',
    'public.tracked_products',
    'UPDATE'
  ),
  'authenticated users cannot update tracked products directly'
);
SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'public.tracked_products',
    'DELETE'
  ),
  'authenticated users cannot delete tracked products directly'
);

SELECT ok(
  (
    SELECT relation_record.relrowsecurity
    FROM pg_class AS relation_record
    WHERE relation_record.oid = 'public.tracker_enrollment_reservations'::regclass
  ),
  'tracker enrollment reservations have RLS enabled'
);
SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'public.tracker_enrollment_reservations',
    'SELECT'
  )
  AND NOT has_any_column_privilege(
    'authenticated',
    'public.tracker_enrollment_reservations',
    'SELECT'
  ),
  'tracker enrollment reservations are hidden from authenticated clients'
);
SELECT ok(
  has_table_privilege(
    'service_role',
    'public.tracker_enrollment_reservations',
    'SELECT'
  )
  AND has_table_privilege(
    'service_role',
    'public.tracker_enrollment_reservations',
    'INSERT'
  )
  AND has_table_privilege(
    'service_role',
    'public.tracker_enrollment_reservations',
    'UPDATE'
  )
  AND has_table_privilege(
    'service_role',
    'public.tracker_enrollment_reservations',
    'DELETE'
  ),
  'service role can maintain the enrollment reservation ledger'
);
SELECT ok(
  to_regprocedure('public.reserve_tracker_enrollment(uuid,uuid)') IS NOT NULL,
  'the atomic tracker enrollment reservation RPC exists'
);
SELECT ok(
  NOT (
    SELECT function_record.prosecdef
    FROM pg_proc AS function_record
    WHERE function_record.oid = to_regprocedure(
      'public.reserve_tracker_enrollment(uuid,uuid)'
    )
  ),
  'the tracker enrollment RPC is security invoker'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.reserve_tracker_enrollment(uuid,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'public',
    'public.reserve_tracker_enrollment(uuid,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.reserve_tracker_enrollment(uuid,uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.reserve_tracker_enrollment(uuid,uuid)',
    'EXECUTE'
  ),
  'only service_role can execute the tracker enrollment RPC'
);

INSERT INTO auth.users (id, email, created_at, updated_at)
VALUES
  (
    '10000000-0000-4000-8000-000000000111',
    'pgtap-profile-011-a@example.invalid',
    now(),
    now()
  ),
  (
    '10000000-0000-4000-8000-000000000112',
    'pgtap-profile-011-b@example.invalid',
    now(),
    now()
  );

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.users
    WHERE id = '10000000-0000-4000-8000-000000000111'
  ),
  'inserting an Auth user automatically provisions its public profile'
);
SELECT is(
  (
    SELECT email FROM public.users
    WHERE id = '10000000-0000-4000-8000-000000000111'
  ),
  'pgtap-profile-011-a@example.invalid',
  'profile provisioning preserves the Auth email'
);
SELECT is(
  (
    SELECT browserbase_context_id FROM public.users
    WHERE id = '10000000-0000-4000-8000-000000000111'
  ),
  NULL::TEXT,
  'profile provisioning leaves browser context service-owned and unset'
);

INSERT INTO public.tracked_products (
  id,
  user_id,
  product_url,
  product_name,
  current_price,
  target_price,
  currency,
  status
) VALUES
  (
    '20000000-0000-4000-8000-000000000211',
    '10000000-0000-4000-8000-000000000111',
    'https://example.invalid/tracker-a',
    'Tracker A',
    10,
    5,
    'USD',
    'active'
  ),
  (
    '20000000-0000-4000-8000-000000000212',
    '10000000-0000-4000-8000-000000000112',
    'https://example.invalid/tracker-b',
    'Tracker B',
    10,
    5,
    'USD',
    'active'
  );

SELECT set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000111',
  true
);
SET LOCAL ROLE authenticated;
DO $rls_test$
BEGIN
  PERFORM set_config(
    'prava.test_visible_tracker_count',
    (
      SELECT count(tracked_product.id)::TEXT
      FROM public.tracked_products AS tracked_product
      WHERE tracked_product.id IN (
        '20000000-0000-4000-8000-000000000211',
        '20000000-0000-4000-8000-000000000212'
      )
    ),
    true
  );
END
$rls_test$;
RESET ROLE;
SELECT is(
  current_setting('prava.test_visible_tracker_count'),
  '1',
  'tracker RLS returns only the authenticated owner row'
);

SELECT is(
  (
    SELECT reservation.reason
    FROM public.reserve_tracker_enrollment(
      '10000000-0000-4000-8000-000000000111',
      '30000000-0000-4000-8000-000000000301'
    ) AS reservation
  ),
  'reserved',
  'the first enrollment attempt reserves capacity before scraping'
);
SELECT ok(
  (
    SELECT reservation.accepted
    FROM public.reserve_tracker_enrollment(
      '10000000-0000-4000-8000-000000000111',
      '30000000-0000-4000-8000-000000000301'
    ) AS reservation
  ),
  'retrying one request ID returns the existing accepted reservation'
);
SELECT is(
  (
    SELECT count(*)
    FROM public.tracker_enrollment_reservations
    WHERE user_id = '10000000-0000-4000-8000-000000000111'
  ),
  1::BIGINT,
  'an idempotent enrollment retry consumes only one hourly attempt'
);

DO $rate_setup$
BEGIN
  PERFORM * FROM public.reserve_tracker_enrollment(
    '10000000-0000-4000-8000-000000000111',
    '30000000-0000-4000-8000-000000000302'
  );
  PERFORM * FROM public.reserve_tracker_enrollment(
    '10000000-0000-4000-8000-000000000111',
    '30000000-0000-4000-8000-000000000303'
  );
  PERFORM * FROM public.reserve_tracker_enrollment(
    '10000000-0000-4000-8000-000000000111',
    '30000000-0000-4000-8000-000000000304'
  );
  PERFORM * FROM public.reserve_tracker_enrollment(
    '10000000-0000-4000-8000-000000000111',
    '30000000-0000-4000-8000-000000000305'
  );
END
$rate_setup$;

SELECT is(
  (
    SELECT reservation.reason
    FROM public.reserve_tracker_enrollment(
      '10000000-0000-4000-8000-000000000111',
      '30000000-0000-4000-8000-000000000306'
    ) AS reservation
  ),
  'rate_limited',
  'a sixth distinct enrollment attempt in one hour is rejected before scraping'
);
SELECT is(
  (
    SELECT count(*)
    FROM public.tracker_enrollment_reservations
    WHERE user_id = '10000000-0000-4000-8000-000000000111'
      AND created_at > now() - interval '1 hour'
  ),
  5::BIGINT,
  'the bounded rate ledger stores at most five hourly attempts per user'
);

INSERT INTO public.tracked_products (
  id,
  user_id,
  product_url,
  product_name,
  current_price,
  target_price,
  currency,
  status
)
SELECT
  gen_random_uuid(),
  '10000000-0000-4000-8000-000000000112',
  'https://example.invalid/quota-' || quota_item.item_number,
  'Quota Tracker ' || quota_item.item_number,
  10,
  5,
  'USD',
  'active'
FROM generate_series(1, 24) AS quota_item(item_number);

SELECT is(
  (
    SELECT reservation.reason
    FROM public.reserve_tracker_enrollment(
      '10000000-0000-4000-8000-000000000112',
      '40000000-0000-4000-8000-000000000401'
    ) AS reservation
  ),
  'quota_exceeded',
  'a user with 25 active trackers cannot reserve another scrape'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.tracker_enrollment_reservations
    WHERE request_id = '40000000-0000-4000-8000-000000000401'
      AND NOT accepted
      AND decision_reason = 'quota_exceeded'
  ),
  'quota rejection is durably recorded as an hourly attempt'
);

SELECT * FROM finish();
ROLLBACK;
