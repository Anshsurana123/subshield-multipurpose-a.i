-- RETIRED: do not paste this file into the Supabase SQL editor.
--
-- The former apply-all script was an independent schema source that diverged
-- from migrations/002_tracked_products.sql and disabled tenant isolation. The
-- canonical schema is now the ordered migration history:
--
--   migrations/001_initial_schema.sql
--   migrations/002_tracked_products.sql
--   migrations/003_tracked_products_chat_source.sql
--   migrations/004_tracked_products_prava_session.sql
--   migrations/005_security_lockdown.sql
--   migrations/006_durable_purchase_foundation.sql
--   migrations/007_atomic_execution_claim.sql
--   migrations/008_purchase_safety_bindings.sql
--   migrations/009_durable_worker_and_tracker_outbox.sql
--   migrations/010_channel_linking.sql
--   migrations/011_auth_profiles_and_tracker_api_boundary.sql
--
-- Use `supabase db reset` for a clean local database and the normal Supabase
-- migration workflow for linked environments. Failing here is intentional: it
-- prevents a future manual run from recreating the unsafe legacy schema.

DO $retired$
BEGIN
  RAISE EXCEPTION
    USING
      MESSAGE = 'supabase/apply-all.sql is retired; apply the ordered migrations instead',
      HINT = 'Use the Supabase migration workflow. Do not bypass migration 005 lockdown or migration 006 legacy ownership checks.';
END
$retired$;
