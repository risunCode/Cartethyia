/**
 * Why a share link stops resolving.
 *
 * The resolver used to answer `null` for every cause, so the public page could
 * only say "link unavailable" — which sent an operator looking in the wrong
 * place: a paused key has to be re-enabled, a revoked one cannot be, and an
 * expired link has to be regenerated. These tests pin the reason each state
 * reports, including the two that are easy to conflate:
 *
 * 1. **Paused vs revoked.** `enabled: false` is a pause — the key still exists
 *    and the owner can undo it. `revokedAt` is permanent.
 * 2. **Expired vs deactivated.** Both stop a link, but a deactivated link was
 *    killed deliberately; calling it "expired" tells the owner to regenerate
 *    it, which is the wrong action.
 *
 * Rows are written through the real pool and deleted in `afterAll`: the store
 * needs a Drizzle handle, which a rolled-back `PoolClient` cannot provide.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DrizzleShareLinkStore, type ShareLinkRefusal } from "../../src/persistence/share-store";
import { hashSecret } from "../../src/security/crypto";
import { getDb } from "../../src/persistence/postgres";
import { getTestPool, requireDatabase } from "../helpers/database";

requireDatabase();

const TOKEN_HASH_LENGTH = 64;
const db = getDb();

/** One tenant shared by every seeded row, so teardown is a single delete. */
let tenantId = "";

async function ensureTenant(): Promise<string> {
  if (tenantId !== "") return tenantId;
  const pool = await getTestPool();
  const result = await pool.query<{ id: string }>(
    "insert into tenants (name, status) values ($1, $2) returning id",
    [`share-refusal-${randomUUID()}`, "active"],
  );
  tenantId = String(result.rows[0]!.id);
  return tenantId;
}

afterAll(async () => {
  if (tenantId === "") return;
  const pool = await getTestPool();
  await pool.query("delete from tenants where id = $1", [tenantId]);
});

interface SeedOptions {
  readonly enabled?: boolean;
  readonly revokedAt?: Date | null;
  readonly active?: boolean;
  readonly expiresAt?: Date | null;
  readonly keyMode?: "share" | "personal";
}

/** A sharing key plus the link pointing at it, returning the token hash. */
async function seedLink(options: SeedOptions = {}): Promise<string> {
  const keyMode = options.keyMode ?? "share";
  const tokenHash = randomUUID().replace(/-/g, "").repeat(2).slice(0, TOKEN_HASH_LENGTH);
  const pool = await getTestPool();
  const key = await pool.query<{ id: string }>(
    `insert into api_keys
       (tenant_id, key_hash, key_mode, label, scopes, model_access_mode, enabled, revoked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      await ensureTenant(),
      // A share template has no credential of its own — that shape is enforced
      // by `api_keys_mode_shape_check` — while a personal key must carry one.
      keyMode === "share" ? null : hashSecret(`rk_test_${randomUUID()}`),
      keyMode,
      "share template",
      JSON.stringify(["routing:invoke"]),
      "whitelist",
      options.enabled ?? true,
      options.revokedAt ?? null,
    ],
  );
  await pool.query(
    `insert into share_links (api_key_id, token_hash, token_encrypted, kind, active, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      String(key.rows[0]!.id),
      tokenHash,
      Buffer.from("ciphertext"),
      keyMode === "share" ? "enroll" : "handoff",
      options.active ?? true,
      options.expiresAt ?? null,
    ],
  );
  return tokenHash;
}

/** The refusal a token reports, or "resolved" if the link serves. */
async function refusalFor(tokenHash: string): Promise<ShareLinkRefusal | "resolved"> {
  const outcome = await new DrizzleShareLinkStore(db).resolveShareLinkOutcome(tokenHash);
  return outcome.ok ? "resolved" : outcome.refusal;
}

describe("share link refusal", () => {
  test("a paused key refuses with `disabled`", async () => {
    expect(await refusalFor(await seedLink({ enabled: false }))).toBe("disabled");
  });

  test("a revoked key refuses with `revoked`", async () => {
    expect(await refusalFor(await seedLink({ revokedAt: new Date() }))).toBe("revoked");
  });

  test("an expired link refuses with `expired`", async () => {
    const tokenHash = await seedLink({ expiresAt: new Date(Date.now() - 60_000) });
    expect(await refusalFor(tokenHash)).toBe("expired");
  });

  test("a deactivated link is reported revoked, not expired", async () => {
    expect(await refusalFor(await seedLink({ active: false }))).toBe("revoked");
  });

  test("an unknown token refuses with `not_found`", async () => {
    expect(await refusalFor("n".repeat(TOKEN_HASH_LENGTH))).toBe("not_found");
  });

  test("a healthy link resolves, and `resolveShareLink` still collapses to null", async () => {
    expect(await refusalFor(await seedLink())).toBe("resolved");
    const store = new DrizzleShareLinkStore(db);
    expect(await store.resolveShareLink(await seedLink({ enabled: false }))).toBeNull();
  });

  test("a paused key cannot be revealed by the handoff kind either", async () => {
    const tokenHash = await seedLink({ keyMode: "personal", enabled: false });
    expect(await refusalFor(tokenHash)).toBe("disabled");
  });
});
