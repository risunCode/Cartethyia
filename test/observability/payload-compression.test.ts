/**
 * Payload frames are gzipped on write and named `jsonl-file`.
 *
 * A frame written before compression existed is plain JSON named `jsonb-file`,
 * and a database that recorded an earlier migration still has the check that
 * only allowed that name. Both must keep working: the reader resolves an old
 * frame, and the forward migration accepts a new row.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  applySqliteMigrations,
  createSqliteDatabase,
} from "../../src/persistence/db-sqlite";
import {
  payloadDirectory,
  prunePayloadFrames,
  readPayloadFrame,
  writePayloadFrame,
  type PayloadFileReference,
} from "../../src/observability/payload-store";

const FRAME_HEADER_BYTES = 4;

function payloadDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-payload-"));
  process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = dir;
  return dir;
}

/** The stored body of one frame, header excluded. */
async function storedBody(reference: PayloadFileReference): Promise<Buffer> {
  const data = await readFile(join(payloadDirectory(), reference.file));
  return data.subarray(reference.offset + FRAME_HEADER_BYTES, reference.offset + reference.length);
}

test("a written frame is gzipped, smaller than its JSON, and reads back whole", async () => {
  payloadDir();
  const repeated = "system prompt repeated on every request. ".repeat(200);
  const payload = { request_id: "request-1", request_body: { prompt: repeated } };

  const reference = await writePayloadFrame(payload, new Date("2026-01-01T00:15:00.000Z"));

  expect(reference.storage).toBe("jsonl-file");
  const stored = await storedBody(reference);
  expect(stored.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  // The decompressed body is the frame, which wraps the payload, so this
  // bounds the frame rather than the payload alone.
  const decompressed = gunzipSync(stored);
  expect(stored.byteLength).toBeLessThan(decompressed.byteLength / 5);
  expect(await readPayloadFrame(reference)).toEqual(payload);
});

test("a frame written as plain JSON before compression still reads back", async () => {
  const dir = payloadDir();
  const payload = { request_id: "old-request", request_body: { prompt: "written before gzip" } };
  const frame = Buffer.from(JSON.stringify({
    version: 1,
    id: "frame-1",
    expiresAt: "2026-01-01T00:15:00.000Z",
    payload,
  }), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(frame.byteLength, 0);
  const file = "2026-01-01T00-legacy.jsonb";
  await Bun.write(join(dir, file), Buffer.concat([header, frame]));

  // The checksum the old writer recorded: FNV-1a over the plain JSON.
  let hash = 2166136261;
  for (let index = 0; index < frame.byteLength; index += 1) {
    hash ^= frame[index]!;
    hash = Math.imul(hash, 16777619);
  }
  const reference: PayloadFileReference = {
    storage: "jsonb-file",
    file,
    offset: 0,
    length: FRAME_HEADER_BYTES + frame.byteLength,
    checksum: (hash >>> 0).toString(16).padStart(8, "0"),
    version: 1,
  };
  expect(await readPayloadFrame(reference)).toEqual(payload);
});

test("a file of only expired compressed frames is reclaimed", async () => {
  payloadDir();
  const reference = await writePayloadFrame(
    { request_id: "gone" },
    new Date("2026-01-01T00:15:00.000Z"),
  );
  const deleted = await prunePayloadFrames(new Date("2026-01-02T00:00:00.000Z"));
  expect(deleted).toBe(1);
  expect(await stat(join(payloadDirectory(), reference.file)).then(() => true).catch(() => false)).toBe(false);
});

test("a compressed frame still inside its window keeps the file", async () => {
  payloadDir();
  await writePayloadFrame({ request_id: "kept" }, new Date("2026-06-01T00:15:00.000Z"));
  const deleted = await prunePayloadFrames(new Date("2026-01-02T00:00:00.000Z"));
  expect(deleted).toBe(0);
});

test("the forward migration lets a compressed frame's row be stored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-migrate-"));
  const file = join(dir, "cartethyia.sqlite");
  const sqlite = createSqliteDatabase(file);
  await applySqliteMigrations(sqlite);

  sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('t1', 'A', 'active')");
  const insert = (storage: string): void => {
    sqlite.exec(
      "INSERT INTO telemetry_payloads (id, tenant_id, captured_at, expires_at, storage, file, offset, length, checksum, version) " +
        `VALUES ('id-${storage}', 't1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z', '${storage}', 'f.jsonb', 0, 4, 'abcd', 1)`,
    );
  };
  insert("jsonb-file");
  insert("jsonl-file");
  expect(() => insert("parquet")).toThrow();

  // Nothing was lost or doubled: the rebuild keeps one row per insert.
  const count = sqlite.prepare("SELECT count(*) AS c FROM telemetry_payloads").get() as { c: number };
  expect(count.c).toBe(2);
  sqlite.close();
});

test("the forward migration keeps rows written before compression", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cartethyia-migrate-"));
  const sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);

  sqlite.exec("INSERT INTO tenants (id, name, status) VALUES ('t1', 'A', 'active')");
  sqlite.exec(
    "INSERT INTO telemetry_payloads (id, tenant_id, captured_at, expires_at, storage, file, offset, length, checksum, version) " +
      "VALUES ('old', 't1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z', 'jsonb-file', 'old.jsonb', 0, 8, 'abcd', 1)",
  );

  // Run the rebuild a second time. It has to be idempotent: a fresh baseline
  // already widened the check, and the forward file still runs there.
  const source = await Bun.file("migrations/lite-sqlite3/0005_payload_jsonl_storage.sql").text();
  sqlite.transaction(() => {
    for (const part of source.split(/--> statement-breakpoint/g)) {
      const statement = part.replace(/--[^\n]*/g, "").trim();
      if (statement.length > 0) sqlite.exec(statement);
    }
  })();

  const row = sqlite.prepare("SELECT storage, file, length FROM telemetry_payloads WHERE id = 'old'").get() as {
    storage: string;
    file: string;
    length: number;
  };
  expect(row).toEqual({ storage: "jsonb-file", file: "old.jsonb", length: 8 });
  sqlite.close();
});
