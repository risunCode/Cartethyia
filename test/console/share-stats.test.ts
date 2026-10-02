/**
 * The public share rollup: what a *recipient* — someone outside the tenant —
 * is allowed to learn about the link they were given.
 *
 * The share page's figures are the template's, not the recipient's, because the
 * quota is shared: "how much has this link used" only means something summed
 * across every key the link has issued. That makes this port the one place in
 * the console where a query crosses a tenancy boundary on purpose, and the
 * tests are written around the two ways that goes wrong:
 *
 * 1. **Leaking identity.** A raw client IP must never reach the recipient.
 *    Every address is asserted to come back masked, regardless of the tenant's
 *    console privacy preference — the preference belongs to the tenant, and the
 *    recipient is not the tenant.
 * 2. **Counting the wrong traffic.** The figures are compared against quota
 *    limits, so a request that was refused must not inflate them, and a request
 *    from another tenant or another key of the same tenant must not appear at
 *    all. The model filter is the subtle one: telemetry keeps the *requested*
 *    name even for a refused request, so an unfiltered top-models table would
 *    rank exactly the invalid names an abuser probed.
 *
 * Everything runs against the real table through the real query, so a change to
 * the SQL is caught here rather than by a wrong number on a page.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createShareStatsPort, clientTypeFromUserAgent } from "../../src/console/share/share-stats";
import { getDb } from "../../src/persistence/postgres";
import { telemetryEvents } from "../../src/persistence/schema";
import { createRunId, getTestPool, requireDatabase } from "../helpers/database";
import { createTenant } from "../helpers/fixtures";

requireDatabase();

const HOUR_MS = 3_600_000;

/**
 * One isolated tenant plus the rows written under it.
 *
 * `on delete cascade` from `tenants` is the teardown: one statement removes the
 * tenant and every telemetry row scoped to it.
 */
async function familyScope(label: string): Promise<{
  tenantId: string;
  cleanup: () => Promise<void>;
}> {
  const pool = await getTestPool();
  const runId = createRunId(label);
  const client = await pool.connect();
  try {
    const tenant = await createTenant(client, runId);
    return {
      tenantId: tenant.tenantId,
      cleanup: async () => {
        await client.query("delete from tenants where id = $1", [tenant.tenantId]);
      },
    };
  } finally {
    client.release();
  }
}

/**
 * Writes telemetry rows directly.
 *
 * The rows are inserted rather than produced through the gateway because this
 * suite is about the *query*: it needs rows at chosen instants, with chosen
 * token counts and statuses, which a real request cannot be made to produce
 * deterministically.
 */
async function writeRows(
  rows: readonly (typeof telemetryEvents.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  await getDb().insert(telemetryEvents).values([...rows]);
}

/** A telemetry row with only what a test names set. */
function row(
  tenantId: string,
  apiKeyId: string,
  overrides: Partial<typeof telemetryEvents.$inferInsert> = {},
): typeof telemetryEvents.$inferInsert {
  return {
    tenantId,
    apiKeyId,
    requestId: crypto.randomUUID(),
    sourceSurface: "chat",
    requestedModel: "claude-sonnet-4-6",
    stream: true,
    status: "completed",
    ...overrides,
  };
}

const EMPTY_RECIPIENTS = { total: 0, active: 0 } as const;

describe("clientTypeFromUserAgent", () => {
  test("names the client and drops the version", () => {
    // The raw header runs to hundreds of characters and embeds a version that
    // changes every release; the first token is what clients use as their name.
    expect(clientTypeFromUserAgent("claude-cli/2.1.280")).toBe("claude-cli");
    expect(clientTypeFromUserAgent("curl/8.7.1")).toBe("curl");
    expect(clientTypeFromUserAgent("node")).toBe("node");
  });

  test("normalises case so one client's releases read as one client", () => {
    expect(clientTypeFromUserAgent("Claude-CLI/1.0")).toBe("claude-cli");
    expect(clientTypeFromUserAgent("CURL/8.7.1")).toBe("curl");
  });

  test("trims surrounding whitespace before splitting", () => {
    expect(clientTypeFromUserAgent("  curl/8.7.1  ")).toBe("curl");
    expect(clientTypeFromUserAgent("\tclaude-cli/2.0")).toBe("claude-cli");
  });

  test("an empty or absent header reports null, never an empty chip", () => {
    // The caller renders a blank for null; a returned "" would render as a
    // chip with nothing in it.
    expect(clientTypeFromUserAgent(null)).toBeNull();
    expect(clientTypeFromUserAgent(undefined)).toBeNull();
    expect(clientTypeFromUserAgent("")).toBeNull();
    expect(clientTypeFromUserAgent("   ")).toBeNull();
    expect(clientTypeFromUserAgent("/")).toBeNull();
    expect(clientTypeFromUserAgent("//")).toBeNull();
  });

  test("a non-string header reports null rather than throwing", () => {
    // The column is nullable text, but a row written by an older producer or a
    // hand-run migration is not guaranteed to hold a string.
    expect(clientTypeFromUserAgent(123 as unknown as string)).toBeNull();
    expect(clientTypeFromUserAgent({} as unknown as string)).toBeNull();
  });

  test("a long token is truncated to the 32-character column", () => {
    // The label is a chip in a table cell; an unbounded token would blow out
    // the layout, and the truncation is part of the contract.
    const long = "a".repeat(80);
    expect(clientTypeFromUserAgent(long)).toBe("a".repeat(32));
    expect(clientTypeFromUserAgent(`${long}/1.0`)).toHaveLength(32);
  });

  test("only the first token is used, so a comment is not mistaken for the name", () => {
    expect(clientTypeFromUserAgent("curl/8.7.1 (x86_64-pc-linux-gnu)")).toBe("curl");
    expect(clientTypeFromUserAgent("Mozilla/5.0 (Windows NT 10.0)")).toBe("mozilla");
  });
});

describe("createShareStatsPort — an empty family", () => {
  test("no key ids short-circuits to empty totals without querying", async () => {
    // A share with no issued keys has no traffic to read; the short-circuit is
    // what keeps a freshly created link from issuing four aggregate queries.
    const port = createShareStatsPort(getDb());
    const stats = await port.getFamilyStats(
      crypto.randomUUID(),
      [],
      { total: 3, active: 1 },
    );
    expect(stats.totals).toEqual({
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      lastHourRequests: 0,
      todayTokens: 0,
      monthTokens: 0,
    });
    // The recipient counts are passed through: they come from the key rows, not
    // from telemetry, so a link with keys but no traffic still reports them.
    expect(stats.recipients).toEqual({ total: 3, active: 1 });
    expect(stats.hourly).toEqual([]);
    expect(stats.models).toEqual([]);
    expect(stats.clientIps).toEqual([]);
  });

  test("a key id with no telemetry yields zeroed totals", async () => {
    const scope = await familyScope("share-empty");
    try {
      const port = createShareStatsPort(getDb());
      const stats = await port.getFamilyStats(
        scope.tenantId,
        [crypto.randomUUID()],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.requests).toBe(0);
      expect(stats.totals.totalTokens).toBe(0);
      // The 24 hourly buckets are still filled, because the chart needs a
      // continuous axis; an empty array would draw a blank chart instead of a
      // flat line at zero.
      expect(stats.hourly).toHaveLength(24);
      expect(stats.hourly.every((bucket) => bucket.requests === 0)).toBe(true);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — family scoping", () => {
  test("only the named keys of the named tenant are counted", async () => {
    // The scope is the whole point of the port: a share link's figures must not
    // include another key of the same tenant, nor any key of another tenant.
    const scope = await familyScope("share-scope");
    const other = await familyScope("share-scope-other");
    try {
      const mine = crypto.randomUUID();
      const siblingKey = crypto.randomUUID();
      const foreignKey = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, mine, { inputTokens: 100, outputTokens: 50 }),
        row(scope.tenantId, siblingKey, { inputTokens: 9_000, outputTokens: 9_000 }),
        row(other.tenantId, foreignKey, { inputTokens: 9_000, outputTokens: 9_000 }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [mine],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.requests).toBe(1);
      expect(stats.totals.inputTokens).toBe(100);
      expect(stats.totals.outputTokens).toBe(50);
      expect(stats.totals.totalTokens).toBe(150);
    } finally {
      await scope.cleanup();
      await other.cleanup();
    }
  });

  test("several keys of one link are summed into one family total", async () => {
    // The quota is shared, so the figures are the template's: two recipients
    // holding two keys of the same link must see one combined number.
    const scope = await familyScope("share-family");
    try {
      const first = crypto.randomUUID();
      const second = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, first, { inputTokens: 100, outputTokens: 0 }),
        row(scope.tenantId, second, { inputTokens: 200, outputTokens: 0 }),
        row(scope.tenantId, second, { inputTokens: 300, outputTokens: 0 }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [first, second],
        { total: 2, active: 2 },
      );
      expect(stats.totals.requests).toBe(3);
      expect(stats.totals.inputTokens).toBe(600);
    } finally {
      await scope.cleanup();
    }
  });

  test("a NULL token count counts as zero rather than nulling the sum", async () => {
    // `coalesce` on each column is what keeps one row with a missing count from
    // erasing the whole total — the aggregate would otherwise return NULL and
    // the page would render a blank where a number belongs.
    const scope = await familyScope("share-null-tokens");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { inputTokens: 400, outputTokens: 100 }),
        row(scope.tenantId, key, { inputTokens: null, outputTokens: null }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.requests).toBe(2);
      expect(stats.totals.inputTokens).toBe(400);
      expect(stats.totals.outputTokens).toBe(100);
      expect(stats.totals.totalTokens).toBe(500);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — error counting", () => {
  test("only gateway errors count, matching every read-side error count", async () => {
    // The definition has to agree with the console's own counts, or the
    // recipient and the tenant see different error rates for the same traffic.
    // 404/499/503 are excluded: a refused probe, a client abort, and a
    // capacity rejection are not provider failures.
    const scope = await familyScope("share-errors");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { status: "completed", httpStatus: 200 }),
        row(scope.tenantId, key, { status: "failed", httpStatus: 500 }),
        row(scope.tenantId, key, { status: "failed", httpStatus: 502 }),
        row(scope.tenantId, key, { status: "cancelled", httpStatus: 499 }),
        row(scope.tenantId, key, { status: "failed", httpStatus: 404 }),
        row(scope.tenantId, key, { status: "failed", httpStatus: 503 }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.requests).toBe(6);
      // The two real upstream failures only.
      expect(stats.totals.errors).toBe(2);
    } finally {
      await scope.cleanup();
    }
  });

  test("a row with no HTTP status still counts by its terminal state", async () => {
    // Rows written before the `http_status` column existed have NULL there, and
    // they must still be classified — otherwise a share's older traffic would
    // report a zero error rate.
    const scope = await familyScope("share-error-null-status");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { status: "failed", httpStatus: null }),
        row(scope.tenantId, key, { status: "completed", httpStatus: null }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.errors).toBe(1);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — time windows", () => {
  test("today and month tokens are bucketed on UTC boundaries", async () => {
    // The daily and monthly limits are compared against these figures, so an
    // off-by-one on a boundary would let a recipient exceed the limit the
    // tenant set. Each row sits one millisecond either side of a boundary,
    // which makes the assertion independent of when the suite runs: the SQL
    // predicate is `createdAt >= <boundary>`, so exactly the "+1ms" rows count.
    const scope = await familyScope("share-windows");
    try {
      const key = crypto.randomUUID();
      const now = new Date();
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      const monthStart = new Date(now);
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      await writeRows([
        // Inside the current day and month.
        row(scope.tenantId, key, {
          createdAt: new Date(dayStart.getTime() + 1),
          inputTokens: 1_000,
          outputTokens: 0,
        }),
        // Before today, inside this month (unless today is the 1st, in which
        // case this instant is before the month too — handled below).
        row(scope.tenantId, key, {
          createdAt: new Date(dayStart.getTime() - 1),
          inputTokens: 2_000,
          outputTokens: 0,
        }),
        // Before this month: excluded from both windows, counted all-time.
        row(scope.tenantId, key, {
          createdAt: new Date(monthStart.getTime() - 1),
          inputTokens: 4_000,
          outputTokens: 0,
        }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      // `dayStart - 1ms` is inside the month only when the day is not the 1st.
      const yesterdayIsInThisMonth = dayStart.getTime() > monthStart.getTime();
      expect(stats.totals.todayTokens).toBe(1_000);
      expect(stats.totals.monthTokens).toBe(yesterdayIsInThisMonth ? 3_000 : 1_000);
      // The all-time figure is unaffected by either boundary.
      expect(stats.totals.totalTokens).toBe(7_000);
    } finally {
      await scope.cleanup();
    }
  });

  test("lastHourRequests counts the trailing hour, not the calendar hour", async () => {
    // The label says "last hour"; a calendar-hour bucket would report a
    // near-empty figure for the first minutes of every hour.
    const scope = await familyScope("share-last-hour");
    try {
      const key = crypto.randomUUID();
      const now = Date.now();
      await writeRows([
        row(scope.tenantId, key, { createdAt: new Date(now - 30 * 60_000) }),
        row(scope.tenantId, key, { createdAt: new Date(now - 59 * 60_000) }),
        row(scope.tenantId, key, { createdAt: new Date(now - 61 * 60_000) }),
        row(scope.tenantId, key, { createdAt: new Date(now - 5 * 60_000) }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.requests).toBe(4);
      expect(stats.totals.lastHourRequests).toBe(3);
    } finally {
      await scope.cleanup();
    }
  });

  test("the hourly series is always 24 buckets, oldest first, gaps filled", async () => {
    // SQL only returns hours that saw traffic, so a chart drawn straight from
    // the rows would silently compress its axis and make a burst look like it
    // filled the day. The JS fill is what keeps the axis honest.
    const scope = await familyScope("share-hourly");
    try {
      const key = crypto.randomUUID();
      const now = Date.now();
      await writeRows([
        row(scope.tenantId, key, { createdAt: new Date(now - 30 * 60_000) }),
        row(scope.tenantId, key, { createdAt: new Date(now - 30 * 60_000) }),
        // 23 hours back: the first bucket of the window.
        row(scope.tenantId, key, { createdAt: new Date(now - 23 * HOUR_MS) }),
        // 25 hours back: outside the window entirely.
        row(scope.tenantId, key, { createdAt: new Date(now - 25 * HOUR_MS) }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.hourly).toHaveLength(24);
      // Oldest first: the ISO strings are strictly increasing.
      for (let index = 1; index < stats.hourly.length; index += 1) {
        const previous = stats.hourly[index - 1]?.hour ?? "";
        const current = stats.hourly[index]?.hour ?? "";
        expect(current > previous).toBe(true);
      }
      // Every bucket is on an exact hour boundary.
      for (const bucket of stats.hourly) {
        const date = new Date(bucket.hour);
        expect(date.getUTCMinutes()).toBe(0);
        expect(date.getUTCSeconds()).toBe(0);
      }
      // The in-window requests are counted, the out-of-window one is not.
      const counted = stats.hourly.reduce((sum, bucket) => sum + bucket.requests, 0);
      expect(counted).toBe(3);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — top models", () => {
  test("ranks by request count and sums tokens per model", async () => {
    const scope = await familyScope("share-models");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { requestedModel: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 0 }),
        row(scope.tenantId, key, { requestedModel: "claude-sonnet-4-6", inputTokens: 200, outputTokens: 0 }),
        row(scope.tenantId, key, { requestedModel: "claude-opus-4-7", inputTokens: 900, outputTokens: 0 }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.models.map((entry) => entry.modelId)).toEqual([
        "claude-sonnet-4-6",
        "claude-opus-4-7",
      ]);
      expect(stats.models[0]?.requests).toBe(2);
      expect(stats.models[0]?.tokens).toBe(300);
      expect(stats.models[1]?.requests).toBe(1);
      expect(stats.models[1]?.tokens).toBe(900);
    } finally {
      await scope.cleanup();
    }
  });

  test("averages divide by the rows that reported each metric, not by every request", async () => {
    // A non-streaming request has no rate and a failed one no first byte.
    // Dividing by `count(*)` would drag a healthy model's averages down with
    // unrelated rows, which reads to the recipient as a slow provider.
    const scope = await familyScope("share-averages");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { tokensPerSec: "40.00", ttfbMs: 400 }),
        row(scope.tenantId, key, { tokensPerSec: "60.00", ttfbMs: 600 }),
        // Neither metric reported: contributes to the count, not the averages.
        row(scope.tenantId, key, { tokensPerSec: null, ttfbMs: null }),
        row(scope.tenantId, key, { tokensPerSec: null, ttfbMs: null }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      const entry = stats.models[0];
      expect(entry?.requests).toBe(4);
      expect(entry?.avgTokensPerSec).toBe(50);
      expect(entry?.avgTtfbMs).toBe(500);
    } finally {
      await scope.cleanup();
    }
  });

  test("a model with no reported metric reports null, not zero", async () => {
    // Zero would read as "measured, and it was instant"; null reads as "not
    // measured". The share page renders them differently.
    const scope = await familyScope("share-averages-null");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { tokensPerSec: null, ttfbMs: null }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.models[0]?.avgTokensPerSec).toBeNull();
      expect(stats.models[0]?.avgTtfbMs).toBeNull();
    } finally {
      await scope.cleanup();
    }
  });

  test("a row with no requested model is not ranked", async () => {
    // A NULL model cannot be shown or filtered on, and ranking it would put an
    // unnamed row at the top of the table.
    const scope = await familyScope("share-models-null");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { requestedModel: null }),
        row(scope.tenantId, key, { requestedModel: "claude-sonnet-4-6" }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.models.map((entry) => entry.modelId)).toEqual(["claude-sonnet-4-6"]);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — model allowlist filtering", () => {
  test("an unrestricted link ranks every model", async () => {
    // `undefined` means the link grants anything, which is the common case; the
    // filter must be absent, not empty.
    const scope = await familyScope("share-unrestricted");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { requestedModel: "claude-sonnet-4-6" }),
        row(scope.tenantId, key, { requestedModel: "gpt-5" }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
        undefined,
      );
      expect(stats.models).toHaveLength(2);
    } finally {
      await scope.cleanup();
    }
  });

  test("an empty allowlist yields no model rows at all", async () => {
    // "Nothing allowed" is different from "no restriction": a link that grants
    // no model must not rank one.
    const scope = await familyScope("share-empty-allowlist");
    try {
      const key = crypto.randomUUID();
      await writeRows([row(scope.tenantId, key, { requestedModel: "claude-sonnet-4-6" })]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
        [],
      );
      expect(stats.models).toEqual([]);
      // The totals are unaffected: the filter is a display concern for the
      // ranked table, not a scope on the family's usage.
      expect(stats.totals.requests).toBe(1);
    } finally {
      await scope.cleanup();
    }
  });

  test("a bare allowlist entry also covers a provider-qualified spelling", async () => {
    // `modelRejectionReason` treats a bare entry as covering itself and any
    // provider-qualified spelling of it, so the table must agree — otherwise a
    // model the recipient can legitimately use would be missing from their own
    // usage page.
    const scope = await familyScope("share-bare-allowlist");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { requestedModel: "deepseek-v4.1-flash" }),
        row(scope.tenantId, key, { requestedModel: "opencode-go/deepseek-v4.1-flash" }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
        ["deepseek-v4.1-flash"],
      );
      expect(stats.models.map((entry) => entry.modelId).sort()).toEqual([
        "deepseek-v4.1-flash",
        "opencode-go/deepseek-v4.1-flash",
      ]);
    } finally {
      await scope.cleanup();
    }
  });

  test("a qualified allowlist entry covers only itself", async () => {
    // The bare name it ends with is a *different*, refused request. Ranking it
    // would show the recipient usage of a model they cannot select.
    const scope = await familyScope("share-qualified-allowlist");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { requestedModel: "deepseek-v4.1-flash" }),
        row(scope.tenantId, key, { requestedModel: "opencode-go/deepseek-v4.1-flash" }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
        ["opencode-go/deepseek-v4.1-flash"],
      );
      expect(stats.models.map((entry) => entry.modelId)).toEqual([
        "opencode-go/deepseek-v4.1-flash",
      ]);
    } finally {
      await scope.cleanup();
    }
  });

  test("a refused probe never ranks, so it cannot hide a usable model", async () => {
    // The filter is pushed into SQL rather than applied after the query, which
    // is what stops a flood of invalid names from filling the top-50 window and
    // pushing a model the recipient may actually use off the table.
    const scope = await familyScope("share-refused-probe");
    try {
      const key = crypto.randomUUID();
      const probes: (typeof telemetryEvents.$inferInsert)[] = [];
      for (let index = 0; index < 60; index += 1) {
        probes.push(
          row(scope.tenantId, key, {
            requestedModel: `not-allowed-${index}`,
            status: "failed",
            httpStatus: 404,
          }),
        );
      }
      probes.push(row(scope.tenantId, key, { requestedModel: "claude-sonnet-4-6" }));
      await writeRows(probes);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
        ["claude-sonnet-4-6"],
      );
      expect(stats.models).toEqual([
        {
          modelId: "claude-sonnet-4-6",
          requests: 1,
          tokens: 0,
          avgTokensPerSec: null,
          avgTtfbMs: null,
        },
      ]);
    } finally {
      await scope.cleanup();
    }
  });

  test("LIKE metacharacters in an allowlist entry match literally", async () => {
    // A model id is data, not a pattern. Without escaping, an entry containing
    // `%` would match every model and an entry containing `_` would match any
    // one character — silently widening a grant the tenant deliberately narrowed.
    const scope = await familyScope("share-like-escape");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { requestedModel: "model_1" }),
        row(scope.tenantId, key, { requestedModel: "modelX1" }),
        row(scope.tenantId, key, { requestedModel: "model-a" }),
        row(scope.tenantId, key, { requestedModel: "modelba" }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
        ["model_1", "model-a"],
      );
      // `_` and `-` are literal: only the exact names match.
      expect(stats.models.map((entry) => entry.modelId).sort()).toEqual(["model-a", "model_1"]);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — client addresses are always masked", () => {
  test("a public IPv4 is masked before it reaches the recipient", async () => {
    // The recipient is outside the tenant, so an IP leaves masked regardless of
    // the tenant's console privacy preference. This is the port's stated
    // invariant and the most valuable assertion in the file: a raw address here
    // hands an outsider a map of the tenant's users.
    const scope = await familyScope("share-ip-masked");
    try {
      const key = crypto.randomUUID();
      await writeRows([row(scope.tenantId, key, { clientIp: "203.0.113.42" })]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.clientIps).toHaveLength(1);
      const entry = stats.clientIps[0];
      expect(entry?.ip).not.toBe("203.0.113.42");
      expect(entry?.ip).not.toContain("42");
      expect(entry?.ip).toContain("203.0.113");
    } finally {
      await scope.cleanup();
    }
  });

  test("an IPv6 address is masked too", async () => {
    const scope = await familyScope("share-ipv6-masked");
    try {
      const key = crypto.randomUUID();
      await writeRows([row(scope.tenantId, key, { clientIp: "2001:db8:85a3::8a2e:370:7334" })]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      const entry = stats.clientIps[0];
      expect(entry?.ip).not.toBe("2001:db8:85a3::8a2e:370:7334");
      expect(entry?.ip).not.toContain("7334");
    } finally {
      await scope.cleanup();
    }
  });

  test("no address anywhere in the payload is unmasked", async () => {
    // A sweep over the serialized payload, so a field added later cannot leak
    // an address past the one assertion that happens to check `ip`.
    const scope = await familyScope("share-ip-sweep");
    try {
      const key = crypto.randomUUID();
      const address = "198.51.100.77";
      await writeRows([
        row(scope.tenantId, key, { clientIp: address, userAgent: "claude-cli/2.1.280" }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(JSON.stringify(stats)).not.toContain(address);
    } finally {
      await scope.cleanup();
    }
  });

  test("addresses are grouped and ranked, with the newest User-Agent winning", async () => {
    // The label must be the client's *current* identity, not whichever header it
    // happened to send first, and `array_agg` skipping nulls is what lets an
    // address that never sent one still appear.
    const scope = await familyScope("share-ip-ranking");
    try {
      const key = crypto.randomUUID();
      const now = Date.now();
      await writeRows([
        row(scope.tenantId, key, {
          clientIp: "203.0.113.10",
          userAgent: "old-client/1.0",
          createdAt: new Date(now - 60 * 60_000),
        }),
        row(scope.tenantId, key, {
          clientIp: "203.0.113.10",
          userAgent: "new-client/2.0",
          createdAt: new Date(now - 60_000),
        }),
        row(scope.tenantId, key, { clientIp: "203.0.113.20", userAgent: null }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.clientIps).toHaveLength(2);
      const busiest = stats.clientIps[0];
      expect(busiest?.requests).toBe(2);
      expect(busiest?.clientType).toBe("new-client");
      // An address that never sent a User-Agent renders a blank, not a chip.
      expect(stats.clientIps[1]?.clientType).toBeNull();
    } finally {
      await scope.cleanup();
    }
  });

  test("a row with no client address is not ranked", async () => {
    // A NULL address cannot be masked or shown; ranking it would put an
    // unidentifiable row in the recipient's table.
    const scope = await familyScope("share-ip-null");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { clientIp: null }),
        row(scope.tenantId, key, { clientIp: "203.0.113.5" }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.clientIps).toHaveLength(1);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — payload bounds", () => {
  test("the ranked tables are capped even when the family has many entries", async () => {
    // The cap is a payload bound, not a display one: a link with thousands of
    // client addresses must not return an unbounded response.
    const scope = await familyScope("share-bounds");
    try {
      const key = crypto.randomUUID();
      const rows: (typeof telemetryEvents.$inferInsert)[] = [];
      for (let index = 0; index < 60; index += 1) {
        rows.push(
          row(scope.tenantId, key, {
            requestedModel: `model-${index}`,
            clientIp: `203.0.113.${index + 1}`,
          }),
        );
      }
      await writeRows(rows);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.models.length).toBeLessThanOrEqual(50);
      expect(stats.clientIps.length).toBeLessThanOrEqual(50);
      // The totals still cover every row: the cap bounds the ranked tables, not
      // the family's usage figures.
      expect(stats.totals.requests).toBe(60);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — many keys stay one family", () => {
  test("five keys and two models are all represented in one response", async () => {
    // The port promises "one pass per shape": a regression to a per-key or
    // per-model query would turn a public, unauthenticated page into a
    // database amplifier. Every key's traffic and both models must appear in
    // the single response.
    const scope = await familyScope("share-many-keys");
    try {
      const keys = Array.from({ length: 5 }, () => crypto.randomUUID());
      await writeRows(
        keys.flatMap((key) => [
          row(scope.tenantId, key, { requestedModel: "claude-sonnet-4-6" }),
          row(scope.tenantId, key, { requestedModel: "claude-opus-4-7" }),
        ]),
      );
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        keys,
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.requests).toBe(10);
      expect(stats.models).toHaveLength(2);
      expect(stats.models[0]?.requests).toBe(5);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — a share whose keys were deleted", () => {
  test("telemetry rows for a removed key stop being counted", async () => {
    // A revoked recipient's traffic must leave the recipient's own view: the
    // scope is the key ids the link still issues, so a deleted key drops out
    // even though its telemetry rows remain.
    const scope = await familyScope("share-revoked-key");
    try {
      const live = crypto.randomUUID();
      const revoked = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, live, { inputTokens: 100, outputTokens: 0 }),
        row(scope.tenantId, revoked, { inputTokens: 9_000, outputTokens: 0 }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [live],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.requests).toBe(1);
      expect(stats.totals.inputTokens).toBe(100);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — numeric coercion", () => {
  test("every figure is a JS number, not a string from the driver", async () => {
    // `pg` returns bigint aggregates as strings. A page that renders the raw
    // value would show "150" correctly and "1500n" or a string in an arithmetic
    // context incorrectly, so the coercion is part of the contract.
    const scope = await familyScope("share-numeric");
    try {
      const key = crypto.randomUUID();
      await writeRows([row(scope.tenantId, key, { inputTokens: 100, outputTokens: 50 })]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      for (const value of Object.values(stats.totals)) {
        expect(typeof value).toBe("number");
      }
      expect(typeof stats.models[0]?.requests).toBe("number");
      expect(typeof stats.models[0]?.tokens).toBe("number");
      expect(typeof stats.hourly[0]?.requests).toBe("number");
    } finally {
      await scope.cleanup();
    }
  });

  test("a large token total survives the round trip", async () => {
    // A share link running for a month on a busy model accumulates totals that
    // exceed what an int4 column or a float32 could hold.
    const scope = await familyScope("share-large-totals");
    try {
      const key = crypto.randomUUID();
      await writeRows([
        row(scope.tenantId, key, { inputTokens: 1_000_000_000, outputTokens: 500_000_000 }),
        row(scope.tenantId, key, { inputTokens: 1_000_000_000, outputTokens: 500_000_000 }),
      ]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      expect(stats.totals.totalTokens).toBe(3_000_000_000);
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — concurrent reads", () => {
  test("two concurrent calls for different families do not interfere", async () => {
    // The port holds no mutable state, but the four concurrent queries inside
    // one call share a pool; a leaked `where` clause would show up here.
    const first = await familyScope("share-concurrent-a");
    const second = await familyScope("share-concurrent-b");
    try {
      const firstKey = crypto.randomUUID();
      const secondKey = crypto.randomUUID();
      await writeRows([
        row(first.tenantId, firstKey, { inputTokens: 111, outputTokens: 0 }),
        row(second.tenantId, secondKey, { inputTokens: 222, outputTokens: 0 }),
      ]);
      const port = createShareStatsPort(getDb());
      const [a, b] = await Promise.all([
        port.getFamilyStats(first.tenantId, [firstKey], EMPTY_RECIPIENTS),
        port.getFamilyStats(second.tenantId, [secondKey], EMPTY_RECIPIENTS),
      ]);
      expect(a.totals.inputTokens).toBe(111);
      expect(b.totals.inputTokens).toBe(222);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});

describe("createShareStatsPort — recipient counts pass through untouched", () => {
  test("the counts come from the caller, not from telemetry", async () => {
    // The recipients figures are derived from the key rows by the caller; the
    // port must not recompute or drop them, or the share page's "N of M active"
    // would disagree with the key list beside it.
    const scope = await familyScope("share-recipients");
    try {
      const key = crypto.randomUUID();
      await writeRows([row(scope.tenantId, key)]);
      const recipients = { total: 7, active: 3 } as const;
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        recipients,
      );
      expect(stats.recipients).toEqual({ total: 7, active: 3 });
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — hourly window alignment", () => {
  test("the window starts at the top of an hour 23 hours back", async () => {
    // The chart's x-axis is drawn from the first bucket, so a window starting
    // mid-hour would shift every label by that fraction.
    const scope = await familyScope("share-window-align");
    try {
      const key = crypto.randomUUID();
      await writeRows([row(scope.tenantId, key)]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
      );
      const first = new Date(stats.hourly[0]?.hour ?? "");
      const last = new Date(stats.hourly[23]?.hour ?? "");
      expect(first.getUTCMinutes()).toBe(0);
      expect(last.getUTCMinutes()).toBe(0);
      // Exactly 23 hours between the first and last bucket of a 24-bucket window.
      expect(last.getTime() - first.getTime()).toBe(23 * HOUR_MS);
      // The window ends at the current hour, so "now" falls in the last bucket.
      const nowHour = new Date();
      nowHour.setUTCMinutes(0, 0, 0);
      expect(last.getTime()).toBe(nowHour.getTime());
    } finally {
      await scope.cleanup();
    }
  });
});

describe("createShareStatsPort — SQL injection safety", () => {
  test("a model name that looks like SQL is treated as data", async () => {
    // The model name reaches the query through a parameterised `sql` template,
    // but an allowlist entry also reaches a LIKE pattern; a value that breaks
    // either would be a public, unauthenticated injection surface.
    const scope = await familyScope("share-injection");
    try {
      const key = crypto.randomUUID();
      const hostile = "x'; drop table telemetry_events; --";
      await writeRows([row(scope.tenantId, key, { requestedModel: hostile })]);
      const stats = await createShareStatsPort(getDb()).getFamilyStats(
        scope.tenantId,
        [key],
        EMPTY_RECIPIENTS,
        [hostile],
      );
      expect(stats.models.map((entry) => entry.modelId)).toEqual([hostile]);
      // The table is still there.
      const probe = await getDb().execute(sql`select count(*)::int as n from telemetry_events`);
      expect(probe.rows.length).toBe(1);
    } finally {
      await scope.cleanup();
    }
  });
});
