import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPayloadFileReference,
  isPayloadFileReference,
  prunePayloadFrames,
  readPayloadFrame,
  writePayloadFrame,
} from "../../src/observability/payload-store";

const originalDirectory = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
let directory: string | undefined;

afterEach(async () => {
  if (originalDirectory === undefined) delete process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
  else process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = originalDirectory;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe(".jsonb telemetry payload storage", () => {
  test("writes and reads a framed payload without PostgreSQL body storage", async () => {
    directory = await mkdtemp(join(tmpdir(), "cartethyia-payload-") );
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = directory;
    const expiresAt = new Date(Date.now() + 60_000);
    const reference = await writePayloadFrame({ request: "hello" }, expiresAt);

    expect(isPayloadFileReference(reference)).toBe(true);
    await expect(readPayloadFrame(reference)).resolves.toEqual({ request: "hello" });
  });

  test("unwraps the wrapped row shape the writer stores", async () => {
    directory = await mkdtemp(join(tmpdir(), "cartethyia-payload-") );
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = directory;
    const reference = await writePayloadFrame({ request: "hello" }, new Date(Date.now() + 60_000));

    // `TelemetryPayloadCapture.capture` wraps the reference as
    // `{ _payload_ref: ... }`; a failed unwrap leaks that raw JSON to the
    // drawer instead of the captured body.
    expect(extractPayloadFileReference({ _payload_ref: reference })).toEqual(reference);
    expect(extractPayloadFileReference(reference)).toEqual(reference);
    expect(extractPayloadFileReference({ request: "hello" })).toBeUndefined();
  });

  test("prunes expired framed payload files", async () => {
    directory = await mkdtemp(join(tmpdir(), "cartethyia-payload-") );
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = directory;
    await writePayloadFrame({ request: "expired" }, new Date(Date.now() - 1_000));

    await expect(prunePayloadFrames(new Date())).resolves.toBe(1);
  });
});
