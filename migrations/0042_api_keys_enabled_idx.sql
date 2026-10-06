-- Auth resolves a key and then rejects a disabled one. The partial index keeps
-- that filter on the index instead of a heap check over every key of a tenant.
CREATE INDEX IF NOT EXISTS "api_keys_enabled_tenant_idx"
  ON "api_keys" ("tenant_id")
  WHERE "enabled" = true;
