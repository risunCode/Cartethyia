-- Unified minimum-balance floor: percent support plus opt-in default.
--
-- `provider_accounts.last_remaining_percent` caches the sweep's lowest
-- remaining quota percent (Codex weekly, Muse rolling/weekly) beside the
-- absolute-credit stamp, so the routing floor can compare in whichever unit
-- the account reported. NULL until a sweep reports a percent window.
--
-- `provider_routing_settings.credit_limit_enabled` flips to opt-in: the floor
-- only enforces when the operator enables it per provider. The default floor
-- drops to 50 so one value fits both units — 50 credits or 50%. Existing rows
-- keep their stored values; only the defaults for new rows change.
ALTER TABLE provider_accounts ADD COLUMN IF NOT EXISTS last_remaining_percent numeric(8, 3);
ALTER TABLE provider_routing_settings ALTER COLUMN credit_limit_enabled SET DEFAULT false;
ALTER TABLE provider_routing_settings ALTER COLUMN credit_limit SET DEFAULT 50;
