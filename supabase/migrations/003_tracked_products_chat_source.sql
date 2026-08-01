-- Migration: Add chat source tracking to tracked_products
-- Enables notifying the originating chat (Telegram / Linq) when a price target is hit.
ALTER TABLE public.tracked_products
  ADD COLUMN IF NOT EXISTS source_channel TEXT,  -- 'telegram' | 'linq' | 'web'
  ADD COLUMN IF NOT EXISTS source_chat_id TEXT;  -- chat id for the originating conversation
