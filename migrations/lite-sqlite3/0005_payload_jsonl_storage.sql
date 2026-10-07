-- SQLite twin of migrations/full-postgres/0005_payload_jsonl_storage.sql.
--
-- Payload frames are gzipped now, and a row names that encoding as
-- `jsonl-file`. The baseline check only allowed `jsonb-file`, so a new
-- capture would be rejected. SQLite cannot alter a CHECK, so the table is
-- rebuilt with the widened one. Rows written before this stay `jsonb-file`.
--
-- Foreign keys stay on. The rebuild copies into a table that carries the same
-- tenant reference, so a row that satisfied it still does, and the runner's
-- transaction makes the swap atomic. A fresh baseline already has the widened
-- check; the rebuild is idempotent, so applying it there changes nothing.
CREATE TABLE "telemetry_payloads_storage_rebuild" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "request_id" text,
  "captured_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "expires_at" text NOT NULL,
  "storage" text NOT NULL,
  "file" text NOT NULL,
  "offset" integer NOT NULL,
  "length" integer NOT NULL,
  "checksum" text NOT NULL,
  "version" integer NOT NULL,
  CONSTRAINT "telemetry_payloads_storage_check" CHECK ("storage" IN ('jsonb-file', 'jsonl-file')),
  CONSTRAINT "telemetry_payloads_version_check" CHECK ("version" = 1),
  CONSTRAINT "telemetry_payloads_offset_check" CHECK ("offset" >= 0),
  CONSTRAINT "telemetry_payloads_length_check" CHECK ("length" > 0),
  CONSTRAINT "telemetry_payloads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO "telemetry_payloads_storage_rebuild" ("id", "tenant_id", "request_id", "captured_at", "expires_at", "storage", "file", "offset", "length", "checksum", "version")
  SELECT "id", "tenant_id", "request_id", "captured_at", "expires_at", "storage", "file", "offset", "length", "checksum", "version" FROM "telemetry_payloads";
--> statement-breakpoint
DROP TABLE "telemetry_payloads";
--> statement-breakpoint
ALTER TABLE "telemetry_payloads_storage_rebuild" RENAME TO "telemetry_payloads";
--> statement-breakpoint
CREATE INDEX "telemetry_payloads_request_id_idx" ON "telemetry_payloads" ("request_id");
--> statement-breakpoint
CREATE INDEX "telemetry_payloads_tenant_request_idx" ON "telemetry_payloads" ("tenant_id", "request_id");
--> statement-breakpoint
CREATE INDEX "telemetry_payloads_expires_idx" ON "telemetry_payloads" ("expires_at");
