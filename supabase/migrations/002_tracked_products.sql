-- Migration: Create tracked_products table for Item Price Tracker + Prava Purchase Orders
CREATE TABLE IF NOT EXISTS public.tracked_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  product_url TEXT NOT NULL,
  product_name TEXT NOT NULL,
  current_price NUMERIC(10, 2) NOT NULL,
  target_price NUMERIC(10, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'target_reached', 'purchased', 'cancelled'
  last_scanned_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast user & status lookup
CREATE INDEX IF NOT EXISTS idx_tracked_products_user_status ON public.tracked_products(user_id, status);

-- Enable RLS
ALTER TABLE public.tracked_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own tracked products" 
ON public.tracked_products FOR ALL 
USING (true);
