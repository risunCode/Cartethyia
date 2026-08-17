/**
 * Console transport contract.
 *
 * Two halves:
 *  1. Behavior of the shared browser transport (query serialization, error
 *     mapping, envelope validation) — mocked fetch, no daemon required.
 *  2. Parity between CONSOLE_ROUTE_MATRIX and the daemon's actually
 *     registered routes, extracted live from the Go sources in
 *     daemon/internal/server/admin/*.go. Extraction covers every
 *     `mux.HandleFunc(...)` registration (string-literal and const-resolved
 *     paths, methods from requireMethod/requireMethods). Trailing-slash
 *     registrations are prefix dispatchers whose sub-routes are decided
 *     inside the handler; those are expanded through DISPATCHER_SUBROUTES,
 *     which is the one manually maintained piece — the test fails whenever
 *     the daemon registers or removes a dispatcher without the table (and
 *     the literal extraction failing to parse fails loudly too).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, type ConsoleHttpMethod } from "../../src/lib/api";
import { consoleFailure, consoleGet, ConsoleContractError } from "../../src/lib/console-api";
import {
  CONSOLE_ROUTE_MATRIX,
  CONSOLE_STREAM_ROUTES,
  isDocumentedConsoleRoute,
} from "../../src/lib/console-routes";
import { serializeConsoleQuery } from "./console-routes.test-utils";

describe("dashboard transport route contract", () => {
  afterEach(() => vi.restoreAllMocks());

  test("checks every retained route against standard methods only", () => {
    expect(CONSOLE_ROUTE_MATRIX.length).toBeGreaterThan(0);
    for (const contract of CONSOLE_ROUTE_MATRIX) {
      expect(contract.route.startsWith("/v2/")).toBe(false);
      expect(contract.route.startsWith("/console/")).toBe(false);
      expect(contract.methods.every((method): method is ConsoleHttpMethod => ["GET", "POST", "PATCH", "DELETE"].includes(method))).toBe(true);
      expect(contract.methods).not.toContain("QUERY");
    }
    expect(isDocumentedConsoleRoute("/settings", "GET")).toBe(true);
    expect(isDocumentedConsoleRoute("/settings", "PATCH")).toBe(true);
    expect(isDocumentedConsoleRoute("/settings", "POST")).toBe(true);
    expect(isDocumentedConsoleRoute("/settings", "DELETE")).toBe(false);
    expect(isDocumentedConsoleRoute("/providers/openai/accounts/batch-delete", "POST")).toBe(true);
    expect(isDocumentedConsoleRoute("/providers/openai/accounts/batch-delete", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute("/auth/oauth/sessions/sess-1", "GET")).toBe(true);
    expect(isDocumentedConsoleRoute("/oauth/sessions/sess-1", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute("/settings", "QUERY" as ConsoleHttpMethod)).toBe(false);
    expect(isDocumentedConsoleRoute("/v1/models", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute("https://api.invalid/console/settings", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute("/v2/https://api.invalid", "GET")).toBe(false);
  });

  test("serializes only bounded, allow-listed query values", () => {
    const accounts = CONSOLE_ROUTE_MATRIX.find((contract) => contract.route === "/providers/:providerId/accounts");
    expect(accounts).toBeDefined();
    expect(serializeConsoleQuery(accounts!, { limit: 100, cursor: "next page", ignored: "not sent" })).toBe("?limit=100&cursor=next+page");
    expect(isDocumentedConsoleRoute("/providers/openai/accounts?limit=100&cursor=next%20page", "GET")).toBe(true);
    expect(isDocumentedConsoleRoute("/providers/openai/accounts?secret=leaked", "GET")).toBe(false);
    expect(isDocumentedConsoleRoute(`/${"x".repeat(600)}`, "GET")).toBe(false);
    // The runtime predicate enforces the same bound the serializer does.
    expect(() => serializeConsoleQuery(accounts!, { cursor: "x".repeat(129) })).toThrow("API query value is too long");
    expect(isDocumentedConsoleRoute(`/providers/openai/accounts?cursor=${"x".repeat(129)}`, "GET")).toBe(false);
  });

  test("keeps SSE stream routes out of the JSON matrix", () => {
    expect(CONSOLE_STREAM_ROUTES.length).toBeGreaterThan(0);
    for (const route of CONSOLE_STREAM_ROUTES) {
      expect(route.includes(":")).toBe(false);
      expect(CONSOLE_ROUTE_MATRIX.some((contract) => (contract.route as string) === route)).toBe(false);
      expect(isDocumentedConsoleRoute(route, "GET")).toBe(false);
    }
  });

  test("propagates cancellation and keeps network failures bounded at the state boundary", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(abort).mockRejectedValueOnce(new TypeError("socket details must not escape")));
    await expect(api("/console/settings", { signal: new AbortController().signal })).rejects.toBe(abort);
    const networkFailure = await consoleGet("/settings").catch((error: unknown) => error);
    expect(consoleFailure(networkFailure)).toEqual({ code: "network_error", message: "API request failed", degraded: true });
  });

  test.each([403, 404, 500, 503])("maps HTTP %i to a stable bounded error", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider credentials must not escape", { status })));
    await expect(api("/console/settings")).rejects.toMatchObject({ status, code: "error", message: `request failed (${status})` });
  });

  test("rejects a successful response with a malformed API envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ meta: { request_id: "req-1" } }), { status: 200 })));
    await expect(consoleGet("/settings")).rejects.toEqual(new ConsoleContractError("invalid_contract", "API response envelope is invalid", 502));
  });
});

/**
 * Daemon-side extraction. The daemon Go package is part of the same repo, so
 * the contract test reads it directly instead of maintaining a second list.
 */
// Vitest runs with the dashboard package as cwd; the daemon tree is a sibling.
const DAEMON_ADMIN_DIR = join(process.cwd(), "..", "daemon", "internal", "server", "admin");

interface GoSource {
  readonly file: string;
  readonly source: string;
}

interface DaemonRegistration {
  readonly path: string;
  readonly methods: readonly string[];
  readonly file: string;
}

const GO_METHODS: Readonly<Record<string, string>> = {
  Delete: "DELETE",
  Get: "GET",
  Head: "HEAD",
  Options: "OPTIONS",
  Patch: "PATCH",
  Post: "POST",
  Put: "PUT",
};

function goMethod(name: string): string {
  return GO_METHODS[name] ?? name.toUpperCase();
}

function listAdminSources(): GoSource[] {
  return readdirSync(DAEMON_ADMIN_DIR)
    .filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"))
    .sort()
    .map((name) => ({ file: name, source: readFileSync(join(DAEMON_ADMIN_DIR, name), "utf8") }));
}

/** Collects simple `name = "value"` string constants (const blocks included). */
function extractStringConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const pattern = /(?:^|\n)\s*(?:const\s+)?([A-Za-z_]\w*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    constants.set(match[1] as string, match[2] as string);
  }
  return constants;
}

/** Reads one call argument, stopping at the top-level comma or closing paren. */
function readArgument(source: string, start: number): { text: string; end: number } {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      if (depth === 0) return { text: source.slice(start, index).trim(), end: index };
      depth -= 1;
    } else if (char === "," && depth === 0) return { text: source.slice(start, index).trim(), end: index };
  }
  throw new Error("unterminated mux.HandleFunc argument in daemon admin source");
}

/** Resolves `"literal"`, `ConstName`, and `+`-concatenations of the two. */
function resolvePathExpression(expression: string, constants: Map<string, string>): string {
  let resolved = "";
  for (const part of expression.split("+")) {
    const token = part.trim();
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
      resolved += token.slice(1, -1);
    } else if (/^[A-Za-z_]\w*$/.test(token)) {
      const value = constants.get(token);
      if (value === undefined) throw new Error(`cannot resolve HandleFunc path identifier ${token} in expression ${expression}`);
      resolved += value;
    } else {
      throw new Error(`unsupported HandleFunc path expression: ${expression}`);
    }
  }
  return resolved;
}

/**
 * Parses the methods a registration accepts. `requireMethod` and
 * `requireMethods` declare them at the registration site; anything else is a
 * prefix dispatcher (plain handler or handleX call) and returns no methods.
 */
function handlerMethods(source: string, start: number): string[] {
  const rest = source.slice(start);
  const single = /^\s*requireMethod\(http\.Method([A-Za-z]\w*)/.exec(rest);
  if (single !== null) return [goMethod(single[1] as string)];
  const multi = /^\s*requireMethods\(map\[string\]http\.HandlerFunc\{/.exec(rest);
  if (multi !== null) {
    const bodyStart = start + (multi[0].length - 1);
    let depth = 0;
    let bodyEnd = -1;
    for (let index = bodyStart; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          bodyEnd = index;
          break;
        }
      }
    }
    if (bodyEnd < 0) throw new Error("unterminated requireMethods map literal in daemon admin source");
    const methods: string[] = [];
    const keys = /http\.Method([A-Za-z]\w*)\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = keys.exec(source.slice(bodyStart, bodyEnd))) !== null) methods.push(goMethod(match[1] as string));
    return methods;
  }
  return [];
}

function extractRegistrations(): DaemonRegistration[] {
  const registrations: DaemonRegistration[] = [];
  for (const { file, source } of listAdminSources()) {
    const constants = extractStringConstants(source);
    const call = /mux\.HandleFunc\(/g;
    let match: RegExpExecArray | null;
    while ((match = call.exec(source)) !== null) {
      const pathArgument = readArgument(source, match.index + match[0].length);
      const path = resolvePathExpression(pathArgument.text, constants);
      if (!path.startsWith("/console")) continue;
      registrations.push({ path, methods: handlerMethods(source, pathArgument.end + 1), file });
    }
  }
  return registrations;
}

/**
 * Manually maintained expansion of the daemon's prefix dispatchers
 * (trailing-slash registrations whose sub-routes and methods are decided
 * inside the handler body). Derived from the dispatcher switch statements;
 * kept honest by the curation test below, which requires the prefix set to
 * match the extracted registrations exactly and every static sub-route
 * segment to appear as a quoted literal in the dispatcher's own file.
 */
const DISPATCHER_SUBROUTES: ReadonlyArray<{
  readonly prefix: string;
  readonly subroutes: ReadonlyArray<{ readonly path: string; readonly methods: readonly string[] }>;
}> = [
  {
    prefix: "/console/accounts/",
    subroutes: [
      { path: "/accounts/:id", methods: ["PATCH", "DELETE"] },
      { path: "/accounts/:id/quota", methods: ["GET", "POST"] },
    ],
  },
  {
    prefix: "/console/providers/",
    subroutes: [
      { path: "/providers/:id/accounts", methods: ["GET", "POST"] },
      { path: "/providers/:id/accounts/batch", methods: ["POST", "PATCH"] },
      { path: "/providers/:id/accounts/batch-delete", methods: ["POST"] },
      { path: "/providers/:id/accounts/:accountId", methods: ["POST", "DELETE"] },
      { path: "/providers/:id/accounts/:accountId/revoke", methods: ["POST"] },
    ],
  },
  {
    prefix: "/console/auth/oauth/sessions/",
    subroutes: [
      { path: "/auth/oauth/sessions/:id", methods: ["GET"] },
      { path: "/auth/oauth/sessions/:id/status", methods: ["GET"] },
      { path: "/auth/oauth/sessions/:id/complete", methods: ["POST"] },
      { path: "/auth/oauth/sessions/:id/cancel", methods: ["POST"] },
    ],
  },
];

/**
 * Daemon console routes the dashboard contract deliberately does not claim.
 * The SSE streams are claimed through CONSOLE_STREAM_ROUTES instead of the
 * JSON fetch matrix, so this list is exactly the intentional gaps; anyone
 * adding a daemon route the dashboard does not use must update it in the same
 * change.
 */
const KNOWN_UNCOVERED_DAEMON_ROUTES = [
  // Daemon-supported mutations the dashboard matrix does not exercise.
  "PATCH /accounts/:param",
  "DELETE /accounts/:param",
  "POST /providers/:param/accounts/:param/revoke",
  // OAuth status polling variant not used by the dashboard.
  "GET /auth/oauth/sessions/:param/status",
].sort();

/** Strips the /console mount and unifies `:name` params for comparison. */
function normalizeConsolePath(path: string): string {
  const stripped = path === "/console" ? "/" : path.replace(/^\/console(?=\/|$)/, "");
  return stripped
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":param" : segment))
    .join("/");
}

function routePairs(path: string, methods: readonly string[]): string[] {
  return methods.map((method) => `${method} ${normalizeConsolePath(path)}`);
}

function daemonConsoleSurface(): { pairs: string[]; dispatchers: DaemonRegistration[] } {
  const registrations = extractRegistrations();
  const dispatchers = registrations.filter((registration) => registration.path.endsWith("/"));
  const pairs = new Set<string>();
  for (const registration of registrations) {
    if (registration.path.endsWith("/")) continue;
    for (const pair of routePairs(registration.path, registration.methods)) pairs.add(pair);
  }
  for (const entry of DISPATCHER_SUBROUTES) {
    for (const subroute of entry.subroutes) {
      for (const pair of routePairs(subroute.path, subroute.methods)) pairs.add(pair);
    }
  }
  return { pairs: [...pairs], dispatchers };
}

describe("daemon console route registration parity", () => {
  test("daemon admin sources never register the legacy /v2/admin surface", () => {
    const sources = listAdminSources();
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.filter((entry) => entry.source.includes("v2/admin")).map((entry) => entry.file);
    expect(offenders).toEqual([]);

    const registrations = extractRegistrations();
    expect(registrations.length).toBeGreaterThanOrEqual(20);
    expect(registrations.every((registration) => registration.path.startsWith("/console/"))).toBe(true);
    expect(registrations.filter((registration) => registration.path.startsWith("/v2/"))).toEqual([]);
  });

  test("every literal console registration declares its HTTP methods", () => {
    const methodless = extractRegistrations()
      .filter((registration) => !registration.path.endsWith("/") && registration.methods.length === 0)
      .map((registration) => `${registration.file}: ${registration.path}`);
    expect(methodless).toEqual([]);
  });

  test("every dispatcher registration is expanded by the curated sub-route table", () => {
    const { dispatchers } = daemonConsoleSurface();
    const registered = dispatchers.map((registration) => registration.path).sort();
    const curated = DISPATCHER_SUBROUTES.map((entry) => entry.prefix).sort();
    expect(registered).toEqual(curated);

    const sources = new Map(listAdminSources().map((entry) => [entry.file, entry.source]));
    for (const entry of DISPATCHER_SUBROUTES) {
      const registration = dispatchers.find((candidate) => candidate.path === entry.prefix);
      expect(registration, `dispatcher ${entry.prefix} must be registered`).toBeDefined();
      if (registration === undefined) continue;
      const source = sources.get(registration.file) ?? "";
      for (const subroute of entry.subroutes) {
        const prefixSegments = new Set(entry.prefix.split("/"));
        const markers = subroute.path
          .split("/")
          .filter((segment) => segment.length > 0 && !segment.startsWith(":") && !prefixSegments.has(segment));
        for (const marker of markers) {
          const quotedForms = [`"${marker}"`, `"/${marker}"`];
          expect(
            quotedForms.some((form) => source.includes(form)),
            `${registration.file} must mention sub-route segment "${marker}" of ${subroute.path} as a quoted literal`,
          ).toBe(true);
        }
      }
    }
  });

  test("every CONSOLE_ROUTE_MATRIX entry maps 1:1 to a registered daemon route", () => {
    const daemonPairs = new Set(daemonConsoleSurface().pairs);
    const missing: string[] = [];
    for (const contract of CONSOLE_ROUTE_MATRIX) {
      for (const method of contract.methods) {
        const pair = `${method} ${normalizeConsolePath(contract.route)}`;
        if (!daemonPairs.has(pair)) missing.push(pair);
      }
    }
    expect(missing, "matrix entries without a daemon registration").toEqual([]);
  });

  test("every CONSOLE_STREAM_ROUTES entry maps 1:1 to a registered daemon stream route", () => {
    const daemonPairs = new Set(daemonConsoleSurface().pairs);
    const missing: string[] = [];
    for (const route of CONSOLE_STREAM_ROUTES) {
      const pair = `GET ${normalizeConsolePath(route)}`;
      if (!daemonPairs.has(pair)) missing.push(pair);
    }
    expect(missing, "stream routes without a daemon registration").toEqual([]);
  });

  test("daemon console routes not covered by the matrix match the maintained list", () => {
    const daemonPairs = daemonConsoleSurface().pairs;
    const claimedPairs = new Set([
      ...CONSOLE_ROUTE_MATRIX.flatMap((contract) => routePairs(contract.route, contract.methods)),
      ...CONSOLE_STREAM_ROUTES.map((route) => `GET ${normalizeConsolePath(route)}`),
    ]);
    const uncovered = daemonPairs.filter((pair) => !claimedPairs.has(pair)).sort();
    expect(uncovered).toEqual(KNOWN_UNCOVERED_DAEMON_ROUTES);
  });
});
