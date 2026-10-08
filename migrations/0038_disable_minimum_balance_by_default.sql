-- Minimum-balance protection is opt-in for every existing provider.
-- The schema default already covers new provider-routing rows; this update
-- removes an earlier enabled state from rows created before that default.
UPDATE provider_routing_settings
SET credit_limit_enabled = false
WHERE credit_limit_enabled = true;

ALTER TABLE provider_routing_settings
  ALTER COLUMN credit_limit_enabled SET DEFAULT false;
