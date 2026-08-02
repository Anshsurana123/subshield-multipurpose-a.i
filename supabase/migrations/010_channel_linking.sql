-- Explicit signed-in-user -> chat identity linking with one-time hashed codes.

BEGIN;

CREATE TABLE public.channel_link_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('telegram', 'linq')),
  code_hash TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX channel_link_requests_active_user_provider_uidx
  ON public.channel_link_requests(user_id, provider)
  WHERE consumed_at IS NULL;

ALTER TABLE public.channel_link_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.channel_link_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_link_requests
  TO service_role;

ALTER TABLE public.workflow_jobs
  DROP CONSTRAINT workflow_jobs_purchase_scope_check,
  ADD CONSTRAINT workflow_jobs_purchase_scope_check CHECK (
    purchase_order_id IS NOT NULL
    OR job_type IN (
      'process_channel_message',
      'send_tracker_chat_alert',
      'send_push_notification',
      'send_channel_link_confirmation'
    )
  );

CREATE OR REPLACE FUNCTION public.consume_channel_link(
  p_provider TEXT,
  p_event_id TEXT,
  p_code_hash TEXT,
  p_provider_user_id TEXT,
  p_chat_id TEXT
)
RETURNS TABLE (
  linked BOOLEAN,
  duplicate BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  request_record public.channel_link_requests%ROWTYPE;
  existing_user_id UUID;
  inserted_event_id TEXT;
BEGIN
  IF p_provider NOT IN ('telegram', 'linq')
     OR length(p_event_id) = 0
     OR length(p_provider_user_id) = 0
     OR length(p_chat_id) = 0 THEN
    RAISE EXCEPTION 'invalid channel link request';
  END IF;

  INSERT INTO public.processed_events(provider, event_id)
  VALUES (p_provider, p_event_id)
  ON CONFLICT DO NOTHING
  RETURNING event_id INTO inserted_event_id;

  IF inserted_event_id IS NULL THEN
    RETURN QUERY SELECT FALSE, TRUE;
    RETURN;
  END IF;

  SELECT identity.user_id INTO existing_user_id
  FROM public.channel_identities AS identity
  WHERE identity.provider = p_provider
    AND identity.provider_user_id = p_provider_user_id
  FOR UPDATE;

  IF existing_user_id IS NOT NULL THEN
    SELECT * INTO request_record
    FROM public.channel_link_requests
    WHERE code_hash = p_code_hash
      AND provider = p_provider
      AND consumed_at IS NULL
      AND expires_at > now();

    IF NOT FOUND OR existing_user_id <> request_record.user_id THEN
      RETURN QUERY SELECT FALSE, FALSE;
      RETURN;
    END IF;
  END IF;

  UPDATE public.channel_link_requests
  SET consumed_at = now()
  WHERE code_hash = p_code_hash
    AND provider = p_provider
    AND consumed_at IS NULL
    AND expires_at > now()
  RETURNING * INTO request_record;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, FALSE;
    RETURN;
  END IF;

  INSERT INTO public.channel_identities (
    user_id,
    provider,
    provider_user_id,
    provider_chat_id,
    verified_at
  ) VALUES (
    request_record.user_id,
    p_provider,
    p_provider_user_id,
    p_chat_id,
    now()
  )
  ON CONFLICT (provider, provider_user_id) DO UPDATE
  SET provider_chat_id = EXCLUDED.provider_chat_id,
      verified_at = now(),
      updated_at = now()
  WHERE public.channel_identities.user_id = EXCLUDED.user_id;

  INSERT INTO public.workflow_jobs (
    purchase_order_id,
    job_type,
    state,
    payload
  ) VALUES (
    NULL,
    'send_channel_link_confirmation',
    'queued',
    jsonb_build_object(
      'provider', p_provider,
      'chatId', p_chat_id,
      'text', '✅ This chat is now linked to your signed-in PRAVA account.'
    )
  );

  RETURN QUERY SELECT TRUE, FALSE;
END
$function$;

REVOKE ALL ON FUNCTION public.consume_channel_link(TEXT, TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_channel_link(TEXT, TEXT, TEXT, TEXT, TEXT)
  TO service_role;

COMMENT ON TABLE public.channel_link_requests IS
  'One-time hashed linking codes created only for authenticated application users.';

COMMIT;
