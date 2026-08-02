-- Canonical clean-install tracker table.
-- Pending purchase orders do not belong in this table; migration 005 provides
-- the durable purchase model and quarantines incompatible legacy tracker rows.
CREATE TABLE IF NOT EXISTS public.tracked_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_url TEXT NOT NULL CHECK (length(btrim(product_url)) > 0),
  product_name TEXT NOT NULL CHECK (length(btrim(product_name)) > 0),
  current_price NUMERIC(12,2) NOT NULL CHECK (current_price >= 0),
  target_price NUMERIC(12,2) NOT NULL CHECK (target_price > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'target_reached', 'purchased', 'cancelled')),
  last_scanned_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tracked_products_user_status_idx
  ON public.tracked_products(user_id, status);

ALTER TABLE public.tracked_products ENABLE ROW LEVEL SECURITY;

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
  updated_at
) ON TABLE public.tracked_products TO authenticated;
GRANT INSERT (
  id,
  user_id,
  product_url,
  product_name,
  current_price,
  target_price,
  currency
) ON TABLE public.tracked_products TO authenticated;
GRANT UPDATE (
  product_url,
  product_name,
  target_price,
  currency,
  updated_at
) ON TABLE public.tracked_products TO authenticated;
GRANT DELETE ON TABLE public.tracked_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tracked_products TO service_role;
