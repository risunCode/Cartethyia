-- Model-scoped health reads filter on (account_id, model_id) and order by
-- created_at. The existing (account_id, created_at) index cannot serve that.
CREATE INDEX IF NOT EXISTS "health_events_account_model_created_idx"
  ON "health_events" ("account_id", "model_id", "created_at" DESC);
