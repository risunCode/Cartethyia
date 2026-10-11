/**
 * An automatic `disabled` is no longer terminal.
 *
 * `disabled` used to be the one state nothing recovered: a credential rejected
 * once — a revoked key, a definitively dead refresh grant — left rotation until
 * an operator noticed by hand and clicked Recover. That is the wrong default for
 * a credential that may come back on its own: keys get re-issued, grants get
 * re-authorized, and an upstream's notion of "invalid" can outrun ours.
 *
 * The safety of automating it is entirely the **deadline**. A row the gateway
 * disables *by itself* carries `cooldownUntil`; a row an *operator* disables
 * keeps it null. So the sweep can undo its own verdict without ever undoing a
 * human's, with no extra column and no way to confuse the two.
 *
 * This runs against a real migrated SQLite file rather than a double, because
 * the property under test is a compound `WHERE` over two status values and a
 * null check — precisely what a chainable double would let me assert instead of
 * prove.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "bun:sqlite";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import type { CartethyiaDatabase } from "../../src/persistence/db-handle";
import { providers, providerAccounts, healthEvents } from "../../src/persistence/schema";
import { and, eq } from "drizzle-orm";
import { sweepExpiredCooldowns } from "../../src/providers/operations/account-health-service";

/** Recovery window the boot-time reader resolves when the env var is unset. */
const DEFAULT_RECOVERY_MS = 86_400_000;

let dir: string | undefined;
let sqlite: SqliteDatabase | undefined;
let db: CartethyiaDatabase | undefined;
let providerId: string | undefined;
let previousMode: string | undefined;

beforeEach(async () => {
  // The sweep's per-model pruning picks its SQL from `resolveDbMode()`, so a
  // file-backed fixture needs the mode to name the backend it is actually
  // writing to. The suite default is `full` (`.env.test` pins it so the pg
  // suites never inherit a developer's lite runtime).
  previousMode = process.env.CARTETHYIA_DB_MODE;
  process.env.CARTETHYIA_DB_MODE = "lite";
  dir = mkdtempSync(join(tmpdir(), "cartethyia-disabled-recovery-"));
  sqlite = createSqliteDatabase(join(dir, "cartethyia.sqlite"));
  await applySqliteMigrations(sqlite);
  db = buildSqliteHandle(sqlite).db;
  delete process.env.CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS;
  const [provider] = await db
    .insert(providers)
    .values({ id: "rec-provider" })
    .returning({ id: providers.id });
  providerId = provider?.id ?? "rec-provider";
});

afterEach(() => {
  sqlite?.close();
  if (dir !== undefined) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows holds the file briefly after close; the temp dir is disposable.
    }
  }
  sqlite = undefined;
  db = undefined;
  dir = undefined;
  providerId = undefined;
  if (previousMode === undefined) delete process.env.CARTETHYIA_DB_MODE;
  else process.env.CARTETHYIA_DB_MODE = previousMode;
});

/** One account row in a given health state, carrying `cooldownUntil`. */
async function insertAccount(options: {
  label: string;
  status: "cooldown" | "disabled";
  cooldownUntil: Date | null;
}): Promise<string> {
  if (!db || !providerId) throw new Error("fixture not initialised");
  const [row] = await db
    .insert(providerAccounts)
    .values({
      providerId,
      label: options.label,
      credentialKind: "api_key",
      status: options.status,
      cooldownUntil: options.cooldownUntil,
      lastErrorCategory: options.status === "disabled" ? "auth_invalidated" : null,
      consecutiveFailures: 4,
    })
    .returning({ id: providerAccounts.id });
  if (!row) throw new Error("account insert returned no row");
  return row.id;
}

async function statusOf(accountId: string): Promise<string | undefined> {
  if (!db) throw new Error("fixture not initialised");
  const [row] = await db
    .select({ status: providerAccounts.status })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  return row?.status;
}

async function cooldownOf(accountId: string): Promise<Date | null | undefined> {
  if (!db) throw new Error("fixture not initialised");
  const [row] = await db
    .select({ cooldownUntil: providerAccounts.cooldownUntil })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  return row?.cooldownUntil;
}

function handle(): CartethyiaDatabase {
  if (!db) throw new Error("fixture not initialised");
  return db;
}

test("an automatic disable whose deadline has elapsed returns to rotation", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
  });

  const recovered = await sweepExpiredCooldowns(handle());

  expect(recovered).toBe(1);
  expect(await statusOf(accountId)).toBe("active");
  expect(await cooldownOf(accountId)).toBeNull();
});

test("an operator disable — no deadline — is never swept", async () => {
  // The whole safety argument rests on this row surviving. If the sweep ever
  // recovers it, the machine has overruled a human.
  const accountId = await insertAccount({
    label: "operator-disabled",
    status: "disabled",
    cooldownUntil: null,
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});

test("an automatic disable whose deadline has not arrived stays parked", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled-pending",
    status: "disabled",
    cooldownUntil: new Date(Date.now() + DEFAULT_RECOVERY_MS),
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(0);
  expect(await statusOf(accountId)).toBe("disabled");
});

test("a plain cooldown is still recovered exactly as before", async () => {
  // The pre-existing behavior, pinned so the `or(...)` clause cannot come at
  // its expense.
  const accountId = await insertAccount({
    label: "cooling",
    status: "cooldown",
    cooldownUntil: new Date(Date.now() - 5_000),
  });
  const stillCooling = await insertAccount({
    label: "cooling-active",
    status: "cooldown",
    cooldownUntil: new Date(Date.now() + 600_000),
  });

  expect(await sweepExpiredCooldowns(handle())).toBe(1);
  expect(await statusOf(accountId)).toBe("active");
  expect(await statusOf(stillCooling)).toBe("cooldown");
});

test("recovery resets the streak and clears the category the row was describing", async () => {
  // A recovered row that kept `auth_invalidated` still rendered the console's
  // "Re-login required" pill above an `active` status: healthy to routing and
  // broken to the operator at once. And keeping `consecutiveFailures` would
  // escalate its *next* failure from a level the row had already climbed out of.
  const accountId = await insertAccount({
    label: "auto-disabled-category",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
  });

  await sweepExpiredCooldowns(handle());

  const [row] = await db!
    .select({
      lastErrorCategory: providerAccounts.lastErrorCategory,
      consecutiveFailures: providerAccounts.consecutiveFailures,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, accountId));
  expect(row?.lastErrorCategory).toBeNull();
  expect(row?.consecutiveFailures).toBe(0);
});

test("recovery is audited as a health event naming the state it came from", async () => {
  const accountId = await insertAccount({
    label: "auto-disabled-audit",
    status: "disabled",
    cooldownUntil: new Date(Date.now() - 1_000),
  });

  await sweepExpiredCooldowns(handle());

  const rows = await db!
    .select({
      fromStatus: healthEvents.fromStatus,
      toStatus: healthEvents.toStatus,
    })
    .from(healthEvents)
    .where(
      and(eq(healthEvents.entityKind, "account"), eq(healthEvents.accountId, accountId)),
    );
  expect(rows).toHaveLength(1);
  // `disabled`, not `cooldown`: an operator reading the log must be able to
  // tell a re-enabled credential from an ordinary window expiring.
  expect(rows[0]?.fromStatus).toBe("disabled");
  expect(rows[0]?.toStatus).toBe("active");
});
