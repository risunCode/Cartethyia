/**
 * Layout/style fingerprint of the built dashboard, measured in a real browser.
 *
 * The Tailwind migration re-expresses `dashboard/src/styles/*.css` and ~850
 * inline `style={{}}` objects as utilities, and its acceptance criterion is that
 * the rendered result is unchanged. Typecheck cannot see a shifted flex gap or
 * a border colour that lost its token, so this measures what matters instead.
 *
 * It builds the dashboard, boots the **real gateway** (the production path that
 * serves both the built dashboard and `/console/api` on one origin), and drives
 * a headless browser through the **browser agent** (`agent-browser`, Puppeteer
 * under the hood) rather than a hand-rolled DevTools-protocol client. Each
 * surface is authenticated the way an operator is — the real sign-in form, not
 * a fabricated session row — and every visible node gets a stable DOM path,
 * its `getBoundingClientRect()` and ~50 resolved computed values. `capture`
 * writes that as the standing baseline; `compare` diffs a fresh capture
 * against it.
 *
 * A handful of endpoints are stubbed at the browser's network layer because
 * their answers are live by nature and would otherwise make `compare` drift:
 *
 * - `GET /console/api/system/health` — live process memory/CPU, polled on the
 *   dashboard cadence and rendered as the Overview memory bars.
 * - `GET /console/api/updates/release` — the GitHub release check, which depends
 *   on an external service and answers `null` when unreachable.
 * - `GET /console/api/system/usage/{summary,chart,by-*,requests}` — the gateway
 *   records its own traffic as it serves the dashboard, so the Usage page's
 *   real answers are monotonic across two runs. The empty window is stubbed.
 * - `GET /console/api/quota/overview` — self-polled while the gateway fills cold
 *   accounts in the background, so its real answer differs between runs.
 * - `GET /console/api/logs` and `/logs/stream` — the Console Log page tails a
 *   live ring the gateway feeds as it serves the dashboard. An empty snapshot
 *   renders the settled "0 of 0 lines" state.
 *
 * The globs carry a trailing `*` because agent-browser matches them against the
 * full URL including the query string (`…/summary` alone would let `?period=24h`
 * through to the real gateway). Page-side non-determinism is pinned too, through
 * an init script: the Model Lab names its session from `Math.random()` (pinned to
 * a deterministic LCG), and React Query stamps every query with `Date.now()`,
 * which the Quota page renders as a `HH:MM` "last updated" — a client clock that
 * no response stub can fix, so `Date.now()` is pinned to a fixed instant.
 *
 * Everything else is left live: the pages are the real console against a real
 * gateway, which is exactly what a styling regression would break. The dev
 * database is **read-only** for this script (the only write is the session row
 * the sign-in form itself creates); it is not the test suite, which stays on
 * the isolated `.env.test` database.
 *
 * ```bash
 * CARTETHYIA_VISUAL_ADMIN_PASSWORD=… bun scripts/dev/visual-baseline.ts capture
 * CARTETHYIA_VISUAL_ADMIN_PASSWORD=… bun scripts/dev/visual-baseline.ts compare
 * ```
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..", "..");
const dashboardDir = resolve(projectRoot, "dashboard");
const baselinePath = resolve(dashboardDir, "visual", "baseline.json");

const HOST = "127.0.0.1";
/** Spare port, so a gateway the operator left running on 12800 never collides. */
const GATEWAY_PORT = Number(process.env.CARTETHYIA_VISUAL_PORT?.trim() ?? 12900);
const ORIGIN = `http://${HOST}:${GATEWAY_PORT}`;

/**
 * The surfaces measured without a session: the landing app, and the two console
 * routes that render with no sign-in. `/console/setup` is excluded on purpose —
 * it branches on a setup-state fetch that the real gateway answers from the dev
 * database, and the wizard itself is a stateful flow, not a layout surface.
 */
const PUBLIC_ROUTES = ["/", "/console/login", "/console/banned"] as const;

/**
 * The authenticated console surfaces. The two `:id` routes are resolved at
 * capture time against the live gateway (first bundled provider and first
 * bundled CLI tool), so a provider the operator removed cannot break the run
 * while the choice stays deterministic within one baseline.
 */
const CONSOLE_ROUTE_TEMPLATES = [
  "/console",
  "/console/usage",
  "/console/providers",
  "/console/providers/:providerId",
  "/console/combos",
  "/console/quota",
  "/console/proxy",
  "/console/cli-tools",
  "/console/cli-tools/:toolId",
  "/console/settings",
  "/console/console-log",
  "/console/model-lab",
] as const;

/**
 * Two viewports: a desktop shell, and the narrow width where the `@container`
 * queries (`rule-row` 820px, `app-shell` 860px) fire and a lost responsive
 * variant shows up as a changed rect rather than a silent pass.
 */
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "narrow", width: 420, height: 900 },
] as const;

const THEMES = ["light", "dark"] as const;

/**
 * Resolved values compared per node. Layout, typography, paint and stacking all
 * appear, because a migration can move any of them: a class that used to
 * contribute a border loses it when it becomes a utility, and only the resolved
 * `borderTopWidth` + `borderTopColor` pair catches that.
 */
const PROBED_PROPS = [
  "display",
  "position",
  "top",
  "left",
  "right",
  "bottom",
  "flexDirection",
  "flexWrap",
  "alignItems",
  "justifyContent",
  "gap",
  "rowGap",
  "columnGap",
  "gridTemplateColumns",
  "placeItems",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "textTransform",
  "whiteSpace",
  "textOverflow",
  "color",
  "backgroundColor",
  "backgroundImage",
  "borderTopWidth",
  "borderTopColor",
  "borderTopStyle",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRadius",
  "boxShadow",
  "opacity",
  "zIndex",
  "overflowX",
  "overflowY",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "cursor",
  "transform",
  "transitionProperty",
  "transitionDuration",
  "transitionTimingFunction",
] as const;

/** Node ceiling, so a pathological DOM cannot make a capture unbounded. */
const MAX_NODES = 8000;

/**
 * Deterministic stand-in for the live system-health endpoint. Carries the full
 * `SystemHealthResponse` contract so the console's own validator accepts it and
 * the Overview memory bars render fixed widths.
 */
const HEALTH_STUB = {
  version: "2.1.0",
  status: "healthy",
  uptime_seconds: 1000,
  database_healthy: true,
  redis_healthy: false,
  redis_configured: false,
  memory_heap_bytes: 536_870_912,
  memory_external_bytes: 268_435_456,
  memory_bytes: 1_073_741_824,
  memory_percent: 50,
  database_in_process: true,
  cpu_percent: 12.5,
  cpu_cores: 8,
  pid: 1,
  platform: "visual-baseline",
  request_count: 42,
  error_count: 0,
  latency_avg_ms: 88,
  latency_p95_ms: 150,
  latency_p99_ms: 210,
  cache_hit_rate_percent: 50,
  avg_tokens_per_sec: 120,
} as const;

/**
 * Deterministic stand-ins for the remaining live telemetry surfaces. The
 * gateway records its own traffic as it serves the dashboard, so the Usage
 * page's real answers are monotonic across two runs and would make `compare`
 * drift even with byte-identical styling. An empty window is the honest
 * "nothing to render yet" state and satisfies each endpoint's dashboard
 * validator (`assertUsage*`), so the page renders its settled empty layout
 * instead of a live chart.
 */
const USAGE_SUMMARY_STUB = {
  period: "24h",
  totals: {
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    errors: 0,
    cancelled: 0,
    truncated: 0,
    statusCounts: [],
    avgDurationMs: 0,
    estimatedCostUsd: 0,
    partial: false,
    cacheHitRate: 0,
    avgTokensPerSec: 0,
  },
} as const;

const USAGE_CHART_STUB = { buckets: [] } as const;

/** Empty rows for any `/system/usage/by-<dimension>` breakdown. */
const USAGE_BY_STUB = { dimension: "model", rows: [] } as const;

const USAGE_REQUESTS_STUB = { items: [] } as const;

/**
 * The quota page self-polls `/quota/overview` while the gateway fills cold
 * accounts in the background, so its real answer differs between runs. The
 * empty projection is the settled "no accounts to show" state.
 */
const QUOTA_OVERVIEW_STUB = { providers: [], accounts: [] } as const;

/**
 * The Console Log page tails a live SSE stream (`/logs/stream`) that the
 * gateway feeds from its in-memory ring as it serves the dashboard, and seeds
 * it from a `/logs` snapshot — both differ between runs. One glob covers the
 * snapshot and the stream; an empty `lines` array renders the settled
 * "0 of 0 lines" state. The stream endpoint answers JSON rather than
 * `text/event-stream`, so the page's EventSource reconnects on its 5s timer,
 * but the stream status is not rendered, so the DOM stays stable.
 */
const LOGS_STUB = { lines: [] } as const;

/**
 * The expression evaluated inside the page to settle it: mounted, fonts
 * resolved, no running animation, no in-flight fetches, and a DOM whose node
 * count and text length have stopped changing (the proxy for "live data has
 * finished arriving").
 */
const SETTLE_PROBE = String.raw`(() => {
  const root = document.getElementById("root");
  return {
    mounted: (root?.childElementCount ?? 0) > 0,
    fonts: document.fonts.status,
    running: document.getAnimations().filter((a) => a.playState === "running").length,
    // Fetches the init script counted; a fan-out of per-entity queries keeps
    // this positive until every response has landed and been rendered.
    inflight: window.__inflight ?? 0,
    count: document.querySelectorAll("*").length,
    scrollH: document.documentElement.scrollHeight,
    // Content fingerprint: a pending query that swaps badge text for its
    // loading placeholder (e.g. "0 Connected" -> "1 Healthy") changes neither
    // the node count nor the scroll height, so those two signals alone would
    // declare the page settled mid-flip. textContent length catches it.
    textLen: document.body ? document.body.textContent.length : -1,
  };
})()`;

/** The full per-node capture, returned as an object so the agent JSON-serialises it once. */
const CAPTURE_PROBE = String.raw`(() => {
  const props = ${JSON.stringify(PROBED_PROPS)};
  const maxNodes = ${MAX_NODES};
  const round = (n) => Math.round(n * 100) / 100;
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 24) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      let index = 0;
      let seen = 0;
      if (parent) {
        for (const child of parent.children) {
          if (child.tagName !== node.tagName) continue;
          seen++;
          if (index === 0 && (child === node || child.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)) index = seen;
        }
        if (index === 0) index = seen;
      }
      parts.unshift(seen > 1 ? tag + "[" + index + "]" : tag);
      node = parent;
    }
    return parts.join(">");
  };
  const root = document.documentElement;
  const nodes = [];
  const all = document.querySelectorAll("*");
  for (let i = 0; i < all.length && nodes.length < maxNodes; i++) {
    const el = all[i];
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const values = {};
    for (const p of props) values[p] = cs[p];
    nodes.push({ p: pathOf(el), r: [round(rect.x), round(rect.y), round(rect.width), round(rect.height)], s: values });
  }
  return {
    v: 1,
    url: location.pathname,
    viewport: [window.innerWidth, window.innerHeight],
    app: root.dataset.app || null,
    theme: root.dataset.theme || null,
    scrollHeight: document.documentElement.scrollHeight,
    fontsReady: document.fonts.status,
    runningAnimations: document.getAnimations().filter((a) => a.playState === "running").length,
    nodes,
  };
})()`;

type Capture = {
  readonly url: string;
  readonly viewport: readonly [number, number];
  readonly app: string | null;
  readonly theme: string | null;
  readonly scrollHeight: number;
  readonly fontsReady: string;
  readonly runningAnimations: number;
  readonly nodes: ReadonlyArray<{ readonly p: string; readonly r: readonly number[]; readonly s: Record<string, string> }>;
};

interface Surface {
  readonly key: string;
  readonly capture: Capture;
}

interface Baseline {
  readonly version: 1;
  readonly capturedAt: string;
  readonly nodeCount: number;
  readonly surfaces: readonly Surface[];
}

// ---------------------------------------------------------------------------
// Browser agent
// ---------------------------------------------------------------------------

/**
 * Resolves the `agent-browser` executable. `CARTETHYIA_BROWSER_AGENT` wins;
 * otherwise the npm-global binary is located (a `.cmd` shim on Windows cannot
 * be exec'd directly, so the underlying `.exe` is found), and on POSIX the
 * executable shell shim in `PATH` is used.
 */
function resolveBrowserAgentBinary(): string {
  const override = process.env.CARTETHYIA_BROWSER_AGENT?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    const candidate = appData
      ? resolve(appData, "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe")
      : undefined;
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "agent-browser";
}

interface AgentResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/**
 * One browser-agent session driven through its CLI. Every command is a fresh
 * subprocess against the same named session, so the browser stays up across
 * calls and each command's stdout is a self-contained answer.
 *
 * `agent-browser` is a client/daemon split: the first command spawns a
 * long-lived session daemon that owns Chrome, and that daemon **inherits the
 * client's stdout pipe write-end**. Reading stdout as a pipe therefore never
 * reaches EOF after the client exits. Each command redirects stdout/stderr to
 * a scratch file instead (a file EOFs by size, not by fd count) and is read
 * back after the process exits. The daemon is given a short `--idle-timeout` so
 * it self-cleans if this script is ever killed mid-run.
 */
class BrowserAgent {
  private readonly session = `cartethyia-visual-${process.pid}`;
  private readonly scratchDir = mkdtempSync(join(tmpdir(), "cartethyia-visual-"));
  private seq = 0;
  private initScriptPath: string | null = null;

  constructor(private readonly bin: string) {}

  /**
   * Installs the deterministic init script, registered once before the first
   * navigation and re-applied by `open` on every load. It does three things:
   *
   * - Pins `Math.random` to a deterministic LCG. The Model Lab welcome screen
   *   names its session from `Math.random()` (`sessionName()`), so without this
   *   the session-title chip's width would differ between the `capture` and
   *   `compare` runs.
   * - Pins the wall clock (`Date.now`). React Query stamps every query's
   *   `dataUpdatedAt` from `Date.now()`, and the Quota page renders it as
   *   `Auto-refresh 60s · HH:MM`; the minute differs between the two runs, and
   *   the glyphs it lands on shift the span's width. It is a client clock, not a
   *   network field, so no response stub can pin it — the clock itself must be.
   * - Tracks in-flight `fetch` calls on `window.__inflight`. Several pages fire
   *   a fan-out of per-entity requests after their list query resolves (the
   *   Providers page reads accounts per provider), and a badge that swaps its
   *   text when they land changes neither the node count nor the text length
   *   while the requests are still open — so `settle` waits on this counter too.
   */
  installInitScript(): void {
    const path = join(this.scratchDir, "init.js");
    writeFileSync(
      path,
      `(() => {
  let s = 42;
  Math.random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  // A fixed instant, so every clock-derived render (React Query's dataUpdatedAt,
  // relative "… ago"/countdown strings) is identical across capture and compare.
  // Timers (setTimeout/setInterval) use the event loop's own clock, so polling
  // and the settle loop are unaffected.
  const FIXED_NOW = 1735689600000;
  Date.now = () => FIXED_NOW;
  window.__inflight = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    window.__inflight += 1;
    return realFetch(...args).finally(() => { window.__inflight -= 1; });
  };
})();`,
      "utf8",
    );
    this.initScriptPath = path;
  }

  async run(args: readonly string[], stdin?: string, timeoutMs = 90_000): Promise<AgentResult> {
    const outPath = join(this.scratchDir, `out-${this.seq++}`);
    const errPath = join(this.scratchDir, `err-${this.seq++}`);
    const base = [this.bin, "--idle-timeout", "10s", "--session", this.session];
    const proc = Bun.spawn([...base, ...args], {
      stdin: stdin !== undefined ? "pipe" : "ignore",
      stdout: Bun.file(outPath),
      stderr: Bun.file(errPath),
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const outcome = await Promise.race([
      proc.exited.then((code) => ({ kind: "exit" as const, code })),
      Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "timeout") {
      proc.kill();
      throw new Error(`agent-browser ${args[0]} timed out after ${timeoutMs}ms`);
    }
    const out = readFileSync(outPath, "utf8").trim();
    const err = readFileSync(errPath, "utf8").trim();
    rmSync(outPath, { force: true });
    rmSync(errPath, { force: true });
    return { code: outcome.code, out, err };
  }

  private async must(args: readonly string[], stdin?: string, timeoutMs?: number): Promise<string> {
    const result = await this.run(args, stdin, timeoutMs);
    if (result.code !== 0) {
      throw new Error(`agent-browser ${args[0]} failed (${result.code}): ${(result.err || result.out).slice(0, 600)}`);
    }
    return result.out;
  }

  /** Evaluates a script whose last expression is a JSON-serialisable object. */
  async evalObject<T>(script: string): Promise<T> {
    const out = await this.must(["eval", "--stdin"], script, 120_000);
    const parsed: unknown = JSON.parse(out);
    return (typeof parsed === "string" ? JSON.parse(parsed) : parsed) as T;
  }

  async open(url: string): Promise<void> {
    const initArgs = this.initScriptPath ? ["--init-script", this.initScriptPath] : [];
    await this.must([...initArgs, "open", url], undefined, 120_000);
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.must(["set", "viewport", String(width), String(height)]);
  }

  /**
   * Sets the `console-theme` preference. Must run on the dashboard origin
   * (after an `open`); the HTML bootstrap reads it synchronously on every later
   * navigation, so subsequent single `open`s pick it up — the app's own
   * mechanism, which the landing app deliberately ignores (dark-only).
   */
  async setThemePreference(theme: (typeof THEMES)[number]): Promise<void> {
    await this.must(["storage", "local", "set", "console-theme", theme]);
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.must(["fill", selector, value]);
  }

  async click(selector: string): Promise<void> {
    await this.must(["click", selector]);
  }

  async waitForText(text: string): Promise<void> {
    await this.must(["wait", "--text", text], undefined, 60_000);
  }

  /** Polls until `selector` exists, so a shell state with no visible marker text is still detectable. */
  async waitForSelector(selector: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const present = await this.evalObject<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (present) return;
      if (Date.now() > deadline) throw new Error(`selector never appeared: ${selector}`);
      await Bun.sleep(300);
    }
  }

  async stub(url: string, body: string): Promise<void> {
    await this.must(["network", "route", url, "--body", body]);
  }

  async close(): Promise<void> {
    await this.run(["close"]).catch(() => undefined);
    rmSync(this.scratchDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

async function startGateway(): Promise<{ kill: () => void }> {
  const build = Bun.spawnSync(["bun", "run", "--cwd", "dashboard", "build"], { cwd: projectRoot });
  if (build.exitCode !== 0) {
    throw new Error(`dashboard build failed:\n${(build.stdout?.toString() ?? "") + (build.stderr?.toString() ?? "")}`.slice(-4_000));
  }

  const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      CARTETHYIA_PUBLIC_ORIGIN: ORIGIN,
      // The dev `.env` already carries lite mode and the encryption key; keep
      // them so the gateway boots the same operator database the sign-in below
      // is authenticating against.
      LOG_LEVEL: "warn",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`gateway never answered on ${ORIGIN}`);
    }
    await Bun.sleep(250);
  }
  return { kill: () => proc.kill() };
}

// ---------------------------------------------------------------------------
// Sign-in and route resolution (real production paths, no seeded rows)
// ---------------------------------------------------------------------------

interface AdminCredentials {
  readonly user: string;
  readonly password: string;
}

function resolveAdminCredentials(): AdminCredentials {
  const user = process.env.CARTETHYIA_VISUAL_ADMIN_USER?.trim() || "admin";
  const password = process.env.CARTETHYIA_VISUAL_ADMIN_PASSWORD?.trim();
  if (!password) {
    throw new Error(
      "CARTETHYIA_VISUAL_ADMIN_PASSWORD is required — the baseline signs in to the console with the real sign-in form",
    );
  }
  return { user, password };
}

/** Signs the browser in through the real form, handling a fresh first-boot wizard if one appears. */
async function signIn(agent: BrowserAgent, creds: AdminCredentials): Promise<void> {
  await agent.open(`${ORIGIN}/console`);

  // The session check is async, so wait for the page to resolve into one of
  // the three terminal states rather than racing a not-yet-rendered form.
  const deadline = Date.now() + 20_000;
  let state = { login: false, setup: false, shell: false };
  for (;;) {
    state = await agent.evalObject<{ login: boolean; setup: boolean; shell: boolean }>(
      `({
        login: !!document.querySelector("#login-username"),
        setup: !!document.querySelector("#setup-username"),
        shell: !!document.querySelector('button[aria-label="Sign out"]'),
      })`,
    );
    if (state.shell || state.login || state.setup) break;
    if (Date.now() > deadline) throw new Error("sign-in page never resolved into a known state");
    await Bun.sleep(300);
  }

  if (state.shell) return;

  if (state.setup) {
    // First boot: the wizard is the only real way an account comes to exist.
    await agent.fill("#setup-username", creds.user);
    await agent.fill("#setup-password", creds.password);
    await agent.fill("#setup-confirm", creds.password);
    await agent.click('button[type="submit"]');
    await agent.waitForText("Sign in");
  }

  await agent.fill("#login-username", creds.user);
  await agent.fill("#login-password", creds.password);
  await agent.click('button[type="submit"]');
  // The signed-in shell has no visible "Sign out" text (the icon-only button
  // carries it as an aria-label), so wait on the selector, not visible text.
  await agent.waitForSelector('button[aria-label="Sign out"]');
}

/** Signs in over the API (same production route) to resolve live route ids without parsing browser cookies. */
async function signInViaApi(creds: AdminCredentials): Promise<string> {
  const response = await fetch(`${ORIGIN}/console/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: creds.user, password: creds.password }),
  });
  if (!response.ok) throw new Error(`console sign-in returned ${response.status}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /session_token=([^;]+)/.exec(setCookie);
  const token = match?.[1];
  if (!token) throw new Error("console sign-in response carried no session_token cookie");
  return token;
}

async function resolveBundledProviderId(token: string): Promise<string> {
  const response = await fetch(`${ORIGIN}/console/api/providers`, {
    headers: { cookie: `session_token=${token}` },
  });
  if (!response.ok) throw new Error(`providers list returned ${response.status}`);
  const list = (await response.json()) as ReadonlyArray<{ providerId?: unknown; isBuiltIn?: unknown }>;
  const first = list.find((entry) => entry.isBuiltIn === true) ?? list[0];
  if (!first || typeof first.providerId !== "string") throw new Error("no bundled provider id resolvable");
  return first.providerId;
}

async function resolveBundledCliToolId(token: string): Promise<string> {
  const response = await fetch(`${ORIGIN}/console/api/cli-tools/registry`, {
    headers: { cookie: `session_token=${token}` },
  });
  if (!response.ok) throw new Error(`cli-tools registry returned ${response.status}`);
  const list = (await response.json()) as ReadonlyArray<{ id?: unknown }>;
  const first = list[0];
  if (!first || typeof first.id !== "string") throw new Error("no bundled cli-tool id resolvable");
  return first.id;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Waits until the route has settled: mounted, fonts loaded, no running
 * animation, no in-flight fetches, and a DOM whose node count, scroll height
 * and text length have all been stable for three consecutive probes. The
 * network-quiet condition is what stops a fan-out of per-entity queries (whose
 * landing swaps badge text) from being frozen mid-flight.
 */
async function settle(agent: BrowserAgent): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastCount = -1;
  let lastScroll = -1;
  let lastTextLen = -1;
  let stable = 0;
  for (;;) {
    const state = await agent.evalObject<{
      mounted: boolean;
      fonts: string;
      running: number;
      inflight: number;
      count: number;
      scrollH: number;
      textLen: number;
    }>(SETTLE_PROBE);
    const settledNow = state.mounted && state.fonts === "loaded" && state.running === 0 && state.inflight === 0;
    stable =
      settledNow && state.count === lastCount && state.scrollH === lastScroll && state.textLen === lastTextLen
        ? stable + 1
        : 0;
    lastCount = state.count;
    lastScroll = state.scrollH;
    lastTextLen = state.textLen;
    if (stable >= 3) return;
    if (Date.now() > deadline) {
      throw new Error(`page never settled: ${JSON.stringify(state)}`);
    }
    await Bun.sleep(300);
  }
}

async function captureSurface(
  agent: BrowserAgent,
  route: string,
  viewport: (typeof VIEWPORTS)[number],
): Promise<Capture> {
  await agent.setViewport(viewport.width, viewport.height);
  // One open per surface: the theme preference was persisted on this origin by
  // the caller, and the HTML bootstrap reads it synchronously on load. A second
  // open just doubles the round-trips for no additional fidelity.
  await agent.open(`${ORIGIN}${route}`);
  await settle(agent);

  const capture = await agent.evalObject<Capture>(CAPTURE_PROBE);
  if (capture.nodes.length === 0) throw new Error(`${route} produced no nodes — the app did not render`);
  if (capture.runningAnimations > 0) throw new Error(`${route} still had ${capture.runningAnimations} running animations after settling`);
  if (capture.fontsReady !== "loaded") throw new Error(`${route} fonts were ${capture.fontsReady} — metrics are not comparable`);
  return capture;
}

async function captureAll(agent: BrowserAgent): Promise<Baseline> {
  const surfaces: Surface[] = [];

  // Theme is a per-origin localStorage preference that survives same-origin
  // navigation, so it is written once per theme block and every subsequent
  // single `open` picks it up through the app's own bootstrap. Loop order is
  // theme -> route -> viewport, which is the only way to make that true without
  // a re-open per surface. Order does not affect the fingerprint (each `open`
  // is a fresh navigation and the only cross-surface state is the theme we set
  // explicitly), and `compare` re-runs this exact sequence.
  const captureSet = async (routes: readonly string[], label: string) => {
    for (const theme of THEMES) {
      await agent.setThemePreference(theme);
      for (const route of routes) {
        for (const viewport of VIEWPORTS) {
          const key = `${route}@${viewport.name}@${theme}`;
          console.log(`  ${label} ${key}`);
          const capture = await captureSurface(agent, route, viewport);
          surfaces.push({ key, capture });
        }
      }
    }
  };

  // Install the deterministic init script before the first navigation: it pins
  // Math.random (Model Lab session title) and counts in-flight fetches (settle).
  agent.installInitScript();

  // Establish the origin before the first preference write (a storage write on
  // `about:blank` has no origin and would throw).
  await agent.open(`${ORIGIN}/`);

  // Public surfaces first, before a session exists.
  await captureSet(PUBLIC_ROUTES, "public");

  // Sign in, then pin every live/external endpoint the authenticated shell reads.
  // Trailing `*` is required: agent-browser matches the glob against the full
  // URL including the query string, so `**/system/usage/summary` alone would
  // let `?period=24h` through to the real gateway.
  const creds = resolveAdminCredentials();
  await signIn(agent, creds);
  await agent.stub("**/system/health", JSON.stringify(HEALTH_STUB));
  await agent.stub("**/updates/release", "null");
  await agent.stub("**/system/usage/summary*", JSON.stringify(USAGE_SUMMARY_STUB));
  await agent.stub("**/system/usage/chart*", JSON.stringify(USAGE_CHART_STUB));
  await agent.stub("**/system/usage/by-*", JSON.stringify(USAGE_BY_STUB));
  await agent.stub("**/system/usage/requests*", JSON.stringify(USAGE_REQUESTS_STUB));
  await agent.stub("**/quota/overview*", JSON.stringify(QUOTA_OVERVIEW_STUB));
  await agent.stub("**/logs*", JSON.stringify(LOGS_STUB));

  const token = await signInViaApi(creds);
  const providerId = await resolveBundledProviderId(token);
  const toolId = await resolveBundledCliToolId(token);
  const consoleRoutes = CONSOLE_ROUTE_TEMPLATES.map((route) =>
    route.replace(":providerId", providerId).replace(":toolId", toolId),
  );

  await captureSet(consoleRoutes, "console");

  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    nodeCount: surfaces.reduce((total, surface) => total + surface.capture.nodes.length, 0),
    surfaces,
  };
}

function writeBaseline(baseline: Baseline): void {
  mkdirSync(resolve(dashboardDir, "visual"), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 1)}\n`, "utf8");
}

function readBaseline(path = baselinePath): Baseline {
  if (!existsSync(path)) throw new Error(`no baseline at ${path} — run \`capture\` first`);
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Rect movement below one layout pixel is browser sub-pixel rounding, not a
 * styling change: the same flex/grid arithmetic lands a few tenths of a px
 * differently between two headless renders. One full px is the floor at which a
 * real visual change (a shifted gap, a moved column) becomes unambiguous.
 */
const RECT_TOLERANCE = 1.0;

/**
 * The rect already captures `top`/`left`/`width`/`height` (and `right`/`bottom`
 * are derived from them), so comparing the standalone layout props separately
 * only double-counts the same sub-pixel noise. They are excluded from the
 * style comparison; the rect is still the authority on geometry.
 */
const RECT_REDUNDANT_PROPS = new Set(["top", "left", "right", "bottom", "width", "height"]);

interface Difference {
  readonly surface: string;
  readonly missing: readonly string[];
  readonly added: readonly string[];
  readonly rectMoved: ReadonlyArray<{ p: string; from: readonly number[]; to: readonly number[] }>;
  readonly styleChanged: ReadonlyArray<{ p: string; prop: string; from: string; to: string }>;
  readonly scrollHeight: readonly [number, number];
}

function diffSurface(before: Capture, after: Capture, key: string): Difference {
  const beforeNodes = new Map(before.nodes.map((n) => [n.p, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.p, n]));

  const missing = [...beforeNodes.keys()].filter((p) => !afterNodes.has(p));
  const added = [...afterNodes.keys()].filter((p) => !beforeNodes.has(p));

  const rectMoved: Array<{ p: string; from: readonly number[]; to: readonly number[] }> = [];
  const styleChanged: Array<{ p: string; prop: string; from: string; to: string }> = [];
  for (const [p, b] of beforeNodes) {
    const a = afterNodes.get(p);
    if (!a) continue;
    if (b.r.some((v, i) => Math.abs(v - (a.r[i] ?? 0)) > RECT_TOLERANCE)) {
      rectMoved.push({ p, from: [...b.r], to: [...a.r] });
    }
    for (const prop of Object.keys(b.s)) {
      if (RECT_REDUNDANT_PROPS.has(prop)) continue;
      const from = b.s[prop];
      const to = a.s[prop];
      if (from !== to) styleChanged.push({ p, prop, from: from ?? "", to: to ?? "" });
    }
  }
  return { surface: key, missing, added, rectMoved, styleChanged, scrollHeight: [before.scrollHeight, after.scrollHeight] };
}

function report(differences: readonly Difference[]): number {
  let total = 0;
  for (const d of differences) {
    const count =
      d.missing.length + d.added.length + d.rectMoved.length + d.styleChanged.length + (d.scrollHeight[0] !== d.scrollHeight[1] ? 1 : 0);
    if (count === 0) {
      console.log(`  ${d.surface.padEnd(40)} identical`);
      continue;
    }
    total += count;
    console.log(`  ${d.surface.padEnd(40)} ${count} difference(s)`);
    if (d.scrollHeight[0] !== d.scrollHeight[1]) console.log(`      scrollHeight ${d.scrollHeight[0]} -> ${d.scrollHeight[1]}`);
    for (const p of [...d.missing, ...d.added]) console.log(`      ${p === "" ? "(empty path)" : p}`);
    for (const m of d.rectMoved.slice(0, 12)) console.log(`      rect  ${m.p}\n            [${m.from.join(", ")}] -> [${m.to.join(", ")}]`);
    for (const c of d.styleChanged.slice(0, 25)) console.log(`      ${c.prop.padEnd(22)} ${c.p}\n            ${c.from} -> ${c.to}`);
    if (d.rectMoved.length > 12 || d.styleChanged.length > 25) {
      console.log(`      ... ${d.rectMoved.length} rect, ${d.styleChanged.length} style differences in total`);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------

const mode = process.argv[2] ?? "compare";
const browserBinary = resolveBrowserAgentBinary();

const gateway = await startGateway();
const agent = new BrowserAgent(browserBinary);
try {
  if (mode === "capture") {
    const baseline = await captureAll(agent);
    writeBaseline(baseline);
    console.log(`Captured ${baseline.surfaces.length} surfaces, ${baseline.nodeCount} nodes -> ${baselinePath}`);
  } else if (mode === "compare") {
    const baseline = readBaseline();
    const after = await captureAll(agent);
    const byKey = new Map(baseline.surfaces.map((s) => [s.key, s.capture]));
    const differences = after.surfaces
      .map((s) => {
        const before = byKey.get(s.key);
        if (!before) throw new Error(`baseline has no surface ${s.key} — re-run \`capture\``);
        return diffSurface(before, s.capture, s.key);
      })
      .sort((a, b) => a.surface.localeCompare(b.surface));
    const problems = report(differences);
    console.log();
    if (problems === 0) console.log(`No visual difference across ${after.surfaces.length} surfaces (${after.nodeCount} nodes).`);
    else {
      console.log(`${problems} difference(s) against the baseline.`);
      process.exitCode = 1;
    }
  } else {
    throw new Error(`unknown mode "${mode}" — use capture or compare`);
  }
} finally {
  await agent.close();
  gateway.kill();
}
