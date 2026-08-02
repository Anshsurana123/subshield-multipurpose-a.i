-- Persist the fail-closed boundary before any legacy-data repair can abort.
-- This migration is intentionally separate from 006: if 006 finds orphaned
-- identities or incompatible data and raises, these revokes remain committed.

BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES
  FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES
  FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC, anon, authenticated, service_role;

DO $lockdown$
DECLARE
  table_name TEXT;
  policy_record RECORD;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users',
    'subscriptions',
    'alternatives',
    'decisions',
    'negotiation_logs',
    'scan_history',
    'notifications',
    'tracked_products'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated',
        table_name
      );
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role',
        table_name
      );
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    END IF;
  END LOOP;

  -- Legacy apply-all.sql installed a FOR ALL USING (true) tracker policy.
  -- Remove every tracker policy before any repair or ownership decision.
  IF to_regclass('public.tracked_products') IS NOT NULL THEN
    FOR policy_record IN
      SELECT policy_name.polname
      FROM pg_policy AS policy_name
      WHERE policy_name.polrelid = 'public.tracked_products'::regclass
    LOOP
      EXECUTE format('DROP POLICY %I ON public.tracked_products', policy_record.polname);
    END LOOP;
  END IF;
END
$lockdown$;

COMMENT ON SCHEMA public IS
  'Application schema locked before durable ownership repair; migration 006 restores least-privilege authenticated access.';

COMMIT;
