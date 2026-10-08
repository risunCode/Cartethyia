/**
 * Grok account health sweep — probes every configured Grok account in order
 * and reports which ones still answer.
 *
 * A Grok free-tier account that has run out of usage does not fail outright:
 * it answers the 407 feature probe with `202`, which the probe maps onto
 * `subscription:free-usage-exhausted`. A healthy account answers `407`. So the
 * probe alone is the health signal — no quota endpoint is consulted.
 *
 * The sweep drives the production `ProviderProbingService`, so every request
 * leaves through the gateway's real adapter with its real identity headers.
 * Nothing here overrides a user agent: a probe that stamped a different
 * identity than live traffic would be testing a request shape the gateway
 * never sends, and would report health it cannot vouch for.
 *
 * Usage:
 *   bun run scripts/commands/grok-health-sweep.ts
 *   bun run scripts/commands/grok-health-sweep.ts --provider grok --batch 10
 */
import { asc, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import { closeDb, getDb } from "../../src/persistence/postgres";
import { providerAccounts } from "../../src/persistence/schema";
import type { ProbeModelResult } from "../../src/providers/discovery/discovery-types";
import { GROK_407_PROBE_PROMPT } from "../../src/providers/discovery/probe-phases";
import { ProviderProbingService } from "../../src/providers/discovery/probing-service";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";
import type { ProbeOutboundBinding } from "../../src/providers/discovery/probing-service";
import type { ValidatedOutboundFetch } from "../../src/providers/provider-registry";
import { ENV_PATH, readEnvFile } from "../internal/env";

/** Accounts per batch. Batches are separated by a randomized pause. */
const DEFAULT_BATCH_SIZE = 10;
/** Bounds of the randomized pause between batches, in milliseconds. */
const MIN_BATCH_DELAY_MS = 1_000;
const MAX_BATCH_DELAY_MS = 2_000;

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** A pause in [min, max) so batches do not land on a fixed cadence. */
function randomizedDelay(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs));
}

interface SweepOptions {
  readonly providerId: string;
  readonly batchSize: number;
  readonly modelId: string | undefined;
}

function parseOptions(argv: readonly string[]): SweepOptions {
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
  };
  const batchRaw = Number(flag("batch") ?? DEFAULT_BATCH_SIZE);
  return {
    providerId: flag("provider") ?? "grok",
    batchSize: Number.isFinite(batchRaw) && batchRaw > 0 ? Math.floor(batchRaw) : DEFAULT_BATCH_SIZE,
    modelId: flag("model"),
  };
}

interface AccountRow {
  readonly id: string;
  readonly label: string;
}

/**
 * Lists the provider's accounts in the order the operator sees them: by list
 * position, not insert time or UUID, so the sweep reads top-to-bottom.
 */
async function listAccounts(db: CartethyiaDatabase, providerId: string): Promise<AccountRow[]> {
  return db
    .select({ id: providerAccounts.id, label: providerAccounts.label })
    .from(providerAccounts)
    .where(eq(providerAccounts.providerId, providerId))
    .orderBy(asc(providerAccounts.sortIndex), asc(providerAccounts.createdAt));
}

/**
 * Whether a probe result means "out of usage" rather than "broken".
 *
 * The 407 probe's own contract is the test. Two shapes mean exhausted:
 * - the account answered, but not `407` — `202` is the documented shape;
 * - the probe failed with the quota error it synthesizes, named by provider
 *   code rather than prose.
 *
 * Note this is exhaustion, not a cooldown: `selectProbeAccount` deliberately
 * admits cooling accounts to the 407 probe so one that recovered flips back,
 * so "cooling" is never a verdict here. Reasoning is likewise not checked
 * here — `computeProbeVerdict` already counts reasoning content as a pass
 * (including a `length`-capped run that reasoned but emitted no text), so it
 * is folded into `ok` before this runs.
 */
function isOutOfUsage(result: ProbeModelResult): boolean {
  if (result.error?.includes("subscription:free-usage-exhausted") === true) return true;
  return result.sample !== undefined && result.sample.trim() !== "407" && !result.ok;
}

function describe(result: ProbeModelResult): string {
  if (result.ok) return `${result.latencyMs}ms · sample ${result.sample ?? "—"}`;
  return result.error ?? "probe failed";
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const env = await readEnvFile(ENV_PATH);
  const databaseUrl = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("✗ DATABASE_URL is not set; cannot list accounts.");
    process.exit(1);
  }
  process.env.DATABASE_URL = databaseUrl;

  const db = getDb();
  const accounts = await listAccounts(db, options.providerId);
  if (accounts.length === 0) {
    console.log(`• No accounts configured for provider '${options.providerId}'.`);
    await closeDb();
    return;
  }

  // Direct outbound: the sweep is an operator tool, not tenant traffic, so it
  // skips pool acquisition. The adapter still owns every identity header —
  // bypassing the pool changes the socket, never the request.
  const outboundFetchFor = (): Promise<ProbeOutboundBinding> =>
    Promise.resolve({ fetch: globalThis.fetch as unknown as ValidatedOutboundFetch });

  const service = new ProviderProbingService({
    db,
    telemetryBuffer: undefined,
    defaultEndpoints: {
      chat: "/v1/chat/completions",
      responses: "/v1/responses",
      messages: "/v1/messages",
    },
    bundledModelCatalog: new Map(),
    outboundFetchFor,
    snapshotInvalidator: { invalidate: () => 0 },
    providerRegistry: createDefaultProviderRegistry(),
  });

  console.log(
    `Sweeping ${accounts.length} '${options.providerId}' account(s) in batches of ${options.batchSize}.`,
  );
  console.log("");

  let healthy = 0;
  let exhausted = 0;
  let errored = 0;

  try {
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index]!;
      const result = await service.probeModel("", options.providerId, {
        modelId: options.modelId ?? account.label,
        prompt: GROK_407_PROBE_PROMPT,
        accountId: account.id,
      });

      const outOfUsage = isOutOfUsage(result);
      if (result.ok) healthy += 1;
      else if (outOfUsage) exhausted += 1;
      else errored += 1;

      const verdict = result.ok ? "HEALTHY" : outOfUsage ? "EXHAUSTED" : "ERROR";
      console.log(
        `[${index + 1}/${accounts.length}] ${verdict.padEnd(9)} ${account.label} (${account.id}) — ${describe(result)}`,
      );

      // Pause between batches only: within a batch the accounts run back to
      // back, and the pause is randomized so the sweep has no fixed rhythm an
      // upstream could mistake for one client hammering it.
      const isBatchEnd = (index + 1) % options.batchSize === 0;
      if (isBatchEnd && index + 1 < accounts.length) {
        await delay(randomizedDelay(MIN_BATCH_DELAY_MS, MAX_BATCH_DELAY_MS));
      }
    }
  } finally {
    await closeDb();
  }

  console.log("");
  console.log(`healthy ${healthy} · exhausted ${exhausted} · error ${errored}`);
}

main().catch((error: unknown) => {
  console.error("✗ sweep failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
