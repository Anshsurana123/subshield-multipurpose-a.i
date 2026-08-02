-- Contract tests for migration 006.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

SELECT plan(30);

SELECT is(
  (
    SELECT count(*)
    FROM unnest(ARRAY[
      'users', 'subscriptions', 'alternatives', 'decisions',
      'negotiation_logs', 'scan_history', 'notifications', 'tracked_products',
      'channel_identities', 'merchant_connections', 'purchase_orders',
      'purchase_items', 'payment_sessions', 'checkout_attempts',
      'transaction_reports', 'processed_events', 'workflow_jobs'
    ]) AS required_table(table_name)
    WHERE to_regclass('public.' || required_table.table_name) IS NOT NULL
  ),
  17::BIGINT,
  'all baseline and durable foundation tables exist'
);

SELECT is(
  (
    SELECT string_agg(enum_value.enumlabel::TEXT, ',' ORDER BY enum_value.enumsortorder)
    FROM pg_enum AS enum_value
    JOIN pg_type AS type_record ON type_record.oid = enum_value.enumtypid
    JOIN pg_namespace AS namespace_record ON namespace_record.oid = type_record.typnamespace
    WHERE namespace_record.nspname = 'public'
      AND type_record.typname = 'purchase_state'
  ),
  'draft,resolving,awaiting_cart_review,cart_confirmed,quoting,awaiting_quote_confirmation,quoted,awaiting_payment_approval,credential_ready,executing,submitted,unknown_reconciliation,completed,declined,failed,canceled,expired',
  'purchase_state labels match the durable state machine'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    JOIN pg_attribute AS column_record
      ON column_record.attrelid = constraint_record.conrelid
     AND column_record.attnum = ANY (constraint_record.conkey)
    WHERE constraint_record.contype = 'f'
      AND constraint_record.conrelid = 'public.users'::regclass
      AND constraint_record.confrelid = 'auth.users'::regclass
      AND column_record.attname = 'id'
  ),
  'public.users.id references auth.users.id'
);

SELECT is(
  (
    SELECT format_type(column_record.atttypid, column_record.atttypmod)
    FROM pg_attribute AS column_record
    WHERE column_record.attrelid = 'public.tracked_products'::regclass
      AND column_record.attname = 'user_id'
      AND NOT column_record.attisdropped
  ),
  'uuid',
  'tracked_products.user_id is UUID'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_record
    WHERE constraint_record.contype = 'f'
      AND constraint_record.conrelid = 'public.tracked_products'::regclass
      AND constraint_record.confrelid = 'auth.users'::regclass
  ),
  'tracked products reference authenticated users'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tracked_products'::regclass
      AND conname = 'tracked_products_source_channel_check'
  ),
  'tracked product source channel is constrained'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.purchase_orders'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%source_channel%telegram%linq%web%'
  ),
  'purchase order source channel uses telegram, linq, and web'
);

SELECT ok(
  NOT (
    SELECT column_record.attnotnull
    FROM pg_attribute AS column_record
    WHERE column_record.attrelid = 'public.workflow_jobs'::regclass
      AND column_record.attname = 'purchase_order_id'
      AND NOT column_record.attisdropped
  ),
  'workflow jobs can be queued before a purchase order exists'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'public.workflow_jobs'::regclass
      AND confrelid = 'public.purchase_orders'::regclass
  ),
  'non-null workflow purchase order IDs retain referential integrity'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'u'
      AND conrelid = 'public.purchase_orders'::regclass
      AND pg_get_constraintdef(oid) = 'UNIQUE (idempotency_key)'
  ),
  'purchase order idempotency keys are unique'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'u'
      AND conrelid = 'public.checkout_attempts'::regclass
      AND pg_get_constraintdef(oid) = 'UNIQUE (purchase_order_id, attempt_number)'
  ),
  'checkout attempt numbers are unique per order'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'p'
      AND conrelid = 'public.processed_events'::regclass
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (provider, event_id)'
  ),
  'processed events are deduplicated by provider and event ID'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'public.purchase_items'::regclass
      AND pg_get_constraintdef(oid) LIKE '%quantity > 0%'
  ),
  'purchase item quantity must be positive'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_class AS relation_record
    JOIN pg_namespace AS namespace_record ON namespace_record.oid = relation_record.relnamespace
    WHERE namespace_record.nspname = 'public'
      AND relation_record.relname = ANY (ARRAY[
        'users', 'subscriptions', 'alternatives', 'decisions',
        'negotiation_logs', 'scan_history', 'notifications', 'tracked_products',
        'channel_identities', 'merchant_connections', 'purchase_orders',
        'purchase_items', 'payment_sessions', 'checkout_attempts',
        'transaction_reports', 'processed_events', 'workflow_jobs'
      ])
      AND relation_record.relrowsecurity
  ),
  17::BIGINT,
  'RLS is enabled on every exposed foundation table'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_policy AS policy_record
    WHERE policy_record.polrelid::regclass = ANY (ARRAY[
      'public.users'::regclass,
      'public.subscriptions'::regclass,
      'public.alternatives'::regclass,
      'public.decisions'::regclass,
      'public.negotiation_logs'::regclass,
      'public.scan_history'::regclass,
      'public.notifications'::regclass,
      'public.tracked_products'::regclass,
      'public.channel_identities'::regclass,
      'public.merchant_connections'::regclass,
      'public.purchase_orders'::regclass,
      'public.purchase_items'::regclass
    ])
      AND coalesce(pg_get_expr(policy_record.polqual, policy_record.polrelid), '') IN ('true', '(true)')
  ),
  'no owner policy uses an unrestricted USING true predicate'
);

SELECT is(
  (
    SELECT count(*) FROM pg_policy
    WHERE polrelid = 'public.tracked_products'::regclass
  ),
  1::BIGINT,
  'tracked products expose only an owner-scoped select policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.purchase_orders'::regclass
      AND polname = 'purchase_orders_select_own'
      AND polcmd = 'r'
  ),
  'purchase orders expose only an owner-scoped read policy'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'users', 'subscriptions', 'alternatives', 'decisions',
      'negotiation_logs', 'scan_history', 'notifications', 'tracked_products',
      'channel_identities', 'merchant_connections', 'purchase_orders',
      'purchase_items', 'payment_sessions', 'checkout_attempts',
      'transaction_reports', 'processed_events', 'workflow_jobs'
    ]) AS exposed_table(table_name)
    WHERE has_table_privilege('anon', 'public.' || exposed_table.table_name, 'SELECT')
       OR has_table_privilege('anon', 'public.' || exposed_table.table_name, 'INSERT')
       OR has_table_privilege('anon', 'public.' || exposed_table.table_name, 'UPDATE')
       OR has_table_privilege('anon', 'public.' || exposed_table.table_name, 'DELETE')
  ),
  'anon has no foundation table privileges'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.payment_sessions', 'SELECT'),
  'payment sessions are service-only'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.checkout_attempts', 'SELECT'),
  'checkout attempts are service-only'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.transaction_reports', 'SELECT'),
  'transaction reports are service-only'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.processed_events', 'SELECT'),
  'processed events are service-only'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.workflow_jobs', 'SELECT'),
  'workflow jobs are service-only'
);

SELECT ok(
  NOT has_column_privilege(
    'authenticated',
    'public.merchant_connections',
    'oauth_secret_ref',
    'SELECT'
  ),
  'authenticated users cannot read OAuth secret references'
);
SELECT ok(
  has_column_privilege(
    'authenticated',
    'public.merchant_connections',
    'provider',
    'SELECT'
  ),
  'authenticated users can read safe merchant connection metadata'
);

SELECT ok(
  NOT has_column_privilege(
    'authenticated',
    'public.tracked_products',
    'prava_session_id',
    'SELECT'
  ),
  'authenticated tracker reads cannot expose payment session linkage'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'payment_sessions', 'checkout_attempts', 'transaction_reports',
      'processed_events', 'workflow_jobs'
    ]) AS service_table(table_name)
    WHERE NOT has_table_privilege('service_role', 'public.' || service_table.table_name, 'SELECT')
       OR NOT has_table_privilege('service_role', 'public.' || service_table.table_name, 'INSERT')
       OR NOT has_table_privilege('service_role', 'public.' || service_table.table_name, 'UPDATE')
       OR NOT has_table_privilege('service_role', 'public.' || service_table.table_name, 'DELETE')
  ),
  'service role has explicit CRUD privileges on internal workflow tables'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index AS index_record
    WHERE index_record.indexrelid = 'public.workflow_jobs_available_idx'::regclass
      AND index_record.indpred IS NOT NULL
  ),
  'workflow queue uses a partial available-job index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index AS index_record
    WHERE index_record.indexrelid = 'public.purchase_orders_source_event_uidx'::regclass
      AND index_record.indisunique
      AND index_record.indpred IS NOT NULL
  ),
  'source events have a partial unique deduplication index'
);

SELECT ok(
  CASE
    WHEN to_regclass('public.tracked_products_legacy') IS NULL THEN true
    ELSE (
      (
        SELECT relation_record.relrowsecurity
        FROM pg_class AS relation_record
        WHERE relation_record.oid = to_regclass('public.tracked_products_legacy')
      )
      AND NOT has_table_privilege(
        'authenticated',
        to_regclass('public.tracked_products_legacy'),
        'SELECT'
      )
      AND has_table_privilege(
        'service_role',
        to_regclass('public.tracked_products_legacy'),
        'SELECT'
      )
      AND NOT has_table_privilege(
        'service_role',
        to_regclass('public.tracked_products_legacy'),
        'UPDATE'
      )
    )
  END,
  'optional legacy tracker quarantine is read-only and service-only'
);

SELECT * FROM finish();
ROLLBACK;
