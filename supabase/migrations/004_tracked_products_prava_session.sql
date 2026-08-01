-- Migration: Track the open Prava session for resumable auto-buy
-- When a target price is hit, the bot creates a Prava session and stores its id
-- here (status 'target_reached'), then polls/executes on subsequent cron runs.
ALTER TABLE public.tracked_products
  ADD COLUMN IF NOT EXISTS prava_session_id TEXT;
