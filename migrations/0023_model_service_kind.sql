-- Per-model service kind: which protocol shape at all, not which chat wire.
--
-- `wire_family` says which chat-shaped wire a model speaks (chat/responses/
-- messages). A model that speaks no chat wire at all — the System One decision
-- API — cannot be described by that column, so this one says it. `llm` is every
-- existing row and the default, so the column is inert for the current catalog;
-- a non-`llm` row is routed to its native passthrough endpoint instead of the
-- canonical surface codecs.
--
-- A plain text column with a default, not a pgEnum: unlike `wire_family` the set
-- is expected to grow (embeddings, tts, …), and each addition would otherwise
-- need an enum migration. Validation lives at the application boundary
-- (`SERVICE_KINDS`).
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "service_kind" text;
--> statement-breakpoint
UPDATE "models" SET "service_kind" = 'llm' WHERE "service_kind" IS NULL;
--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "service_kind" SET DEFAULT 'llm';
--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "service_kind" SET NOT NULL;
