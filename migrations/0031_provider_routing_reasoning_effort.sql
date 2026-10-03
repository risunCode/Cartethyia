-- Default reasoning effort per provider routing settings.
--
-- The dashboard's "Thinking" picker previously lived only in browser
-- localStorage and fed the probe/test path exclusively; real dispatch through
-- a combo or a direct provider call never saw it. This column moves the
-- operator's choice server-side: when an inbound request carries no reasoning
-- intent of its own, dispatch applies the routed provider's
-- `default_reasoning_effort` before encoding the upstream payload. Requests
-- that already state an effort always win; the combo's member order
-- (fallback / round robin) is untouched — effort never influences member
-- selection, only what is sent to whichever member is chosen.
--
-- NULL (the default, and every existing row) means "auto": dispatch sends no
-- reasoning intent, exactly as before. The value is one of the canonical
-- ladder strings minus `none` (an operator wanting reasoning off leaves the
-- column NULL); the API layer validates the membership.
--
-- Idempotent: guarded by an information_schema check so a database that
-- already has the column (e.g. a fresh install that ran the updated baseline)
-- is a no-op rather than an error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_routing_settings' AND column_name = 'default_reasoning_effort'
  ) THEN
    ALTER TABLE "provider_routing_settings" ADD COLUMN "default_reasoning_effort" text;
  END IF;
END $$;
