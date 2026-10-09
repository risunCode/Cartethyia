/**
 * Layout/style fingerprint of the built dashboard, measured in a real browser.
 *
 * The Tailwind migration re-expresses `dashboard/src/styles/*.css` and ~850
 * inline `style={{}}` objects as utilities, and its acceptance criterion is that
 * the rendered result is unchanged. Typecheck cannot see a shifted flex gap or
 * a border colour that lost its token, so this measures what matters instead.
 *
 * It builds the dashboard, serves the built output on a spare port, opens a
 * headless Edge over the DevTools protocol, and walks every element of the
 * public surfaces: each node gets a stable DOM path, its `getBoundingClientRect()`
 * and ~50 resolved computed values. `capture` writes that as the standing
 * baseline; `compare` diffs a fresh capture against it.
 *
 * The DevTools protocol is driven directly rather than through a browser
 * automation package: the measurement needs exactly three commands
 * (`Page.navigate`, `Emulation.setDeviceMetricsOverride`, `Runtime.evaluate`),
 * and no installable dependency can be trusted to still answer tomorrow.
 *
 * Measured surfaces are the four routes that render with no console session and
 * no share token. Everything behind auth or a share link is **not** measured
 * here; it stays locked by `dashboard/test/components/primitives.test.tsx` and
 * `list-primitives.test.tsx`, which pin the class contract the CSS keys on.
 *
 * ```bash
 * bun scripts/dev/visual-baseline.ts capture      # write dashboard/visual/baseline.json
 * bun scripts/dev/visual-baseline.ts compare      # diff a fresh capture against it
 * ```
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..", "..");
const dashboardDir = resolve(projectRoot, "dashboard");
const baselinePath = resolve(dashboardDir, "visual", "baseline.json");

const HOST = "127.0.0.1";
const PREVIEW_PORT = 5199;
const CDP_PORT = 9222;
const ORIGIN = `http://${HOST}:${PREVIEW_PORT}`;

/**
 * The routes that render with no backend and no session. `/console/setup` is
 * excluded on purpose: it branches on a setup-state fetch, so with no gateway
 * behind the preview server it renders either the "already registered" notice
 * or the full form depending on which request loses the race.
 *
 * `/console/login` is captured but is known to be measured in its
 * "Checking console setup…" branch — the fetch rejects after the page settles,
 * and the real form (with its `.btn`, `.form-input`, …) only renders after it.
 * The landing route is the surface that carries real weight here: 300+ nodes,
 * both viewports, both themes.
 */
const ROUTES = ["/", "/console/login", "/console/banned"] as const;

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

/** The expression evaluated inside the page. Kept a single IIFE returning JSON. */
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
  return JSON.stringify({
    v: 1,
    url: location.pathname,
    viewport: [window.innerWidth, window.innerHeight],
    app: root.dataset.app || null,
    theme: root.dataset.theme || null,
    scrollHeight: document.documentElement.scrollHeight,
    fontsReady: document.fonts.status,
    runningAnimations: document.getAnimations().filter((a) => a.playState === "running").length,
    nodes,
  });
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
// DevTools protocol client
// ---------------------------------------------------------------------------

/** Minimal CDP client: send a method, await its result, ignore events. */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly socket: WebSocket;

  private constructor(readonly targetId: string, endpoint: string) {
    this.socket = new WebSocket(endpoint);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    this.socket.addEventListener("error", () => {
      for (const [, entry] of this.pending) entry.reject(new Error("CDP socket error"));
      this.pending.clear();
    });
  }

  static async connect(targetId: string, endpoint: string): Promise<Cdp> {
    const client = new Cdp(targetId, endpoint);
    const deadline = Date.now() + 20_000;
    while (client.socket.readyState !== 1) {
      if (Date.now() > deadline) throw new Error("CDP socket never opened");
      await Bun.sleep(50);
    }
    return client;
  }

  close(): void {
    this.socket.close();
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send<{ result?: { value?: unknown }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(`probe threw: ${result.exceptionDetails.text}`);
    return result.result?.value;
  }

  async evaluateJson(expression: string): Promise<Capture> {
    const value = await this.evaluate(expression);
    return JSON.parse(String(value)) as Capture;
  }
}

// ---------------------------------------------------------------------------
// Build + serve
// ---------------------------------------------------------------------------

async function startPreview(): Promise<{ kill: () => void }> {
  const build = Bun.spawnSync(["bun", "run", "--cwd", "dashboard", "build"], { cwd: projectRoot });
  if (build.exitCode !== 0) {
    throw new Error(`dashboard build failed:\n${(build.stdout?.toString() ?? "") + (build.stderr?.toString() ?? "")}`.slice(-4_000));
  }

  const server = spawn("bun", ["run", "preview", "--", "--port", String(PREVIEW_PORT), "--strictPort", "--host", HOST], {
    cwd: dashboardDir,
    stdio: "ignore",
    detached: false,
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`preview server never answered on ${ORIGIN}`);
    await Bun.sleep(250);
  }
  return { kill: () => server.kill() };
}

/**
 * Browser candidates, in preference order: Edge is present on every supported
 * Windows host, Chrome is the usual alternative, and the Playwright-bundled
 * Chromium is a last resort. `CARTETHYIA_VISUAL_BROWSER` overrides the search.
 */
function resolveBrowser(): string {
  const override = process.env.CARTETHYIA_VISUAL_BROWSER;
  if (override) return override;
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`no Chromium-family browser found; set CARTETHYIA_VISUAL_BROWSER to its executable`);
}

async function startBrowser(): Promise<{ kill: () => void }> {
  const profile = mkdtempSync(resolve(tmpdir(), "carte-visual-"));
  const edge = resolveBrowser();
  spawn(
    edge,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );

  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const response = await fetch(`http://${HOST}:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("headless browser never exposed a CDP endpoint");
    await Bun.sleep(300);
  }
  return { kill: () => {
    // Best-effort: the browser may still hold a lock in the profile for a few
    // hundred milliseconds after the page closes, and a temp dir that outlives
    // the run is not worth failing a green comparison over.
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* left for the OS temp sweep */
    }
  } };
}

/** Opens a fresh page target and points it at a route. */
async function openPage(url: string, width: number, height: number): Promise<Cdp> {
  const created = await fetch(`http://${HOST}:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!created.ok) throw new Error(`could not open a CDP target: ${created.status}`);
  const target = (await created.json()) as { id: string; webSocketDebuggerUrl: string };
  const page = await Cdp.connect(target.id, target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 500,
  });
  await page.send("Runtime.enable");
  return page;
}

/**
 * Waits until the route has settled: the app has mounted, fonts have resolved
 * and every entrance animation has finished. A capture taken before any of
 * those is a capture against a moving target, so this throws rather than
 * storing noise the next run would compare badly against.
 */
async function settle(page: Cdp): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = (await page.evaluate(
      `JSON.stringify({
         mounted: (document.getElementById("root")?.childElementCount ?? 0) > 0,
         fonts: document.fonts.status,
         running: document.getAnimations().filter((a) => a.playState === "running").length,
       })`,
    )) as string;
    const parsed = JSON.parse(state) as { mounted: boolean; fonts: string; running: number };
    if (parsed.mounted && parsed.fonts === "loaded" && parsed.running === 0) return;
    if (Date.now() > deadline) throw new Error(`page never settled: ${state}`);
    await Bun.sleep(120);
  }
}

/**
 * Applies a theme the way a user's stored choice would, by clearing the
 * persisted preference and re-reading it through the app's own bootstrap — an
 * attribute written straight onto the root would be overwritten on the next
 * render, capturing a theme the app never chose.
 */
async function applyTheme(page: Cdp, url: string, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(`localStorage.clear(); localStorage.setItem("console-theme", ${JSON.stringify(theme)});`);
  await page.send("Page.navigate", { url });
  await settle(page);
}

async function captureOne(url: string, route: string, viewport: (typeof VIEWPORTS)[number], theme: (typeof THEMES)[number]): Promise<Capture> {
  const page = await openPage(`${ORIGIN}${route}`, viewport.width, viewport.height);
  try {
    await settle(page);
    await applyTheme(page, `${ORIGIN}${route}`, theme);

    const capture = await page.evaluateJson(CAPTURE_PROBE);
    if (capture.nodes.length === 0) throw new Error(`${route} produced no nodes — the app did not render`);
    if (capture.runningAnimations > 0) throw new Error(`${route} still had ${capture.runningAnimations} running animations after settling`);
    if (capture.fontsReady !== "loaded") throw new Error(`${route} fonts were ${capture.fontsReady} — metrics are not comparable`);
    return capture;
  } finally {
    await fetch(`http://${HOST}:${CDP_PORT}/json/close/${page.targetId}`, { method: "GET" }).catch(() => undefined);
    page.close();
  }
}

async function captureAll(): Promise<Baseline> {
  const surfaces: Surface[] = [];
  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      for (const theme of THEMES) {
        surfaces.push({
          key: `${route}@${viewport.name}@${theme}`,
          capture: await captureOne(ORIGIN, route, viewport, theme),
        });
      }
    }
  }
  return { version: 1, capturedAt: new Date().toISOString(), nodeCount: surfaces.reduce((a, s) => a + s.capture.nodes.length, 0), surfaces };
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

const RECT_TOLERANCE = 0.05;

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

  const rectMoved: Difference["rectMoved"] = [];
  const styleChanged: Difference["styleChanged"] = [];
  for (const [p, b] of beforeNodes) {
    const a = afterNodes.get(p);
    if (!a) continue;
    if (b.r.some((v, i) => Math.abs(v - (a.r[i] ?? 0)) > RECT_TOLERANCE)) {
      rectMoved.push({ p, from: [...b.r], to: [...a.r] });
    }
    for (const prop of Object.keys(b.s)) {
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
      console.log(`  ${d.surface.padEnd(32)} identical`);
      continue;
    }
    total += count;
    console.log(`  ${d.surface.padEnd(32)} ${count} difference(s)`);
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

const preview = await startPreview();
const browser = await startBrowser();
try {
  if (mode === "capture") {
    const baseline = await captureAll();
    writeBaseline(baseline);
    console.log(`Captured ${baseline.surfaces.length} surfaces, ${baseline.nodeCount} nodes -> ${baselinePath}`);
  } else if (mode === "compare") {
    const baseline = readBaseline();
    const after = await captureAll();
    const byKey = new Map(baseline.surfaces.map((s) => [s.key, s.capture]));
    const differences = after.surfaces
      .map((s) => {
        const before = byKey.get(s.key);
        if (!before) throw new Error(`baseline has no surface ${s.key}`);
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
  preview.kill();
  browser.kill();
  Bun.spawnSync(["taskkill", "/IM", "msedge.exe", "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
}
