/**
 * Local E2E validation for the v2.1 console surface.
 *
 * Targets the single public edge at port 12800 (the daemon directly in local
 * dev, the nginx edge under compose). Runs the cookie-authenticated console
 * lifecycle end to end: health, login, session, JSON reads, both SSE
 * handshakes, and the two regression guards (legacy /v2/admin is gone,
 * unauthenticated session reads are rejected).
 *
 * Usage:
 *   CONSOLE_PASSWORD=... bunx tsx scripts/validate-fullstack.ts
 *
 * Environment:
 *   CARTETHYIA_BASE_URL  edge base URL (default http://127.0.0.1:12800)
 *   CONSOLE_PASSWORD     console login password (default cartethyia-dev-12800)
 *
 * Uses only fetch/AbortController, so it runs under Bun and Node 18+.
 */

const BASE_URL = (process.env.CARTETHYIA_BASE_URL ?? "http://127.0.0.1:12800").replace(/\/+$/, "");
const CONSOLE_PASSWORD = process.env.CONSOLE_PASSWORD ?? "cartethyia-dev-12800";
const SESSION_COOKIE = "cartethyia_session";
const REQUEST_TIMEOUT_MS = 15_000;
const SSE_FIRST_EVENT_TIMEOUT_MS = 5_000;

interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
}

const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed });
  const line = `${passed ? "PASS" : "FAIL"}  ${name}`;
  console.log(detail === undefined || detail.length === 0 ? line : `${line} — ${detail}`);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bodyExcerpt(body: string): string {
  const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 160);
  return excerpt.length > 0 ? `: ${excerpt}` : "";
}

/** Extracts the cartethyia_session cookie pair from a Set-Cookie header list. */
function sessionCookieFrom(response: Response): string {
  const rawValues =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  for (const raw of rawValues) {
    const pair = (raw.split(";")[0] ?? "").trim();
    if (pair.startsWith(`${SESSION_COOKIE}=`) && pair.length > `${SESSION_COOKIE}=`.length) {
      return pair;
    }
  }
  return "";
}

async function request(path: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cookieHeader(cookie: string): Record<string, string> {
  return cookie.length > 0 ? { cookie } : {};
}

async function expectStatus(name: string, method: string, path: string, expected: number, init: RequestInit = {}): Promise<void> {
  try {
    const response = await request(path, { method, ...init });
    const body = await response.text();
    const passed = response.status === expected;
    record(
      name,
      passed,
      passed ? `HTTP ${response.status}` : `expected HTTP ${expected}, got ${response.status}${bodyExcerpt(body)}`,
    );
  } catch (error) {
    record(name, false, errorDetail(error));
  }
}

async function login(): Promise<string> {
  try {
    const response = await request("/console/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: CONSOLE_PASSWORD, remember: true }),
    });
    const body = await response.text();
    const cookie = sessionCookieFrom(response);
    const passed = response.status === 200 && cookie.length > 0;
    record(
      "POST /console/auth/login (200 + cartethyia_session cookie)",
      passed,
      passed
        ? `HTTP ${response.status}`
        : `HTTP ${response.status}${cookie.length > 0 ? "" : ", no cartethyia_session Set-Cookie"}${bodyExcerpt(body)}`,
    );
    return cookie;
  } catch (error) {
    record("POST /console/auth/login (200 + cartethyia_session cookie)", false, errorDetail(error));
    return "";
  }
}

/** Reads an SSE body until the first `data:` line or the timeout fires. */
async function expectSseFirstDataLine(path: string, label: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSE_FIRST_EVENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: cookieHeader(sessionCookie),
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      const body = await response.text();
      record(label, false, `expected HTTP 200, got ${response.status}${bodyExcerpt(body)}`);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDataLine = false;
    try {
      while (!sawDataLine) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        sawDataLine = buffer.split(/\r?\n/).some((line) => line.startsWith("data:"));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    record(
      label,
      sawDataLine,
      sawDataLine ? "HTTP 200, first data: frame received" : `stream closed or timed out after ${SSE_FIRST_EVENT_TIMEOUT_MS / 1000}s without a data: line`,
    );
  } catch (error) {
    record(label, false, controller.signal.aborted ? `timed out after ${SSE_FIRST_EVENT_TIMEOUT_MS / 1000}s` : errorDetail(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Verifies the SSE handshake headers, then drops the body without reading it. */
async function expectSseHandshake(path: string, label: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: cookieHeader(sessionCookie),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.body !== null) {
      await response.body.cancel().catch(() => undefined);
    }
    const passed = response.status === 200 && contentType.startsWith("text/event-stream");
    record(
      label,
      passed,
      passed
        ? `HTTP 200, content-type ${contentType}`
        : `expected HTTP 200 + text/event-stream, got ${response.status} + ${contentType.length > 0 ? contentType : "no content-type"}`,
    );
  } catch (error) {
    record(label, false, errorDetail(error));
  } finally {
    clearTimeout(timer);
  }
}

let sessionCookie = "";

async function run(): Promise<void> {
  console.log(`Cartethyia v2.1 full-stack validation — ${BASE_URL}\n`);

  await expectStatus("GET /health", "GET", "/health", 200);

  sessionCookie = await login();
  const authed = cookieHeader(sessionCookie);

  await expectStatus("GET /console/auth/session", "GET", "/console/auth/session", 200, { headers: authed });
  await expectStatus("GET /console/dashboard", "GET", "/console/dashboard", 200, { headers: authed });
  await expectStatus(
    "GET /console/telemetry/overview?period=24h",
    "GET",
    "/console/telemetry/overview?period=24h",
    200,
    { headers: authed },
  );
  await expectStatus("GET /console/telemetry/usage", "GET", "/console/telemetry/usage", 200, { headers: authed });
  await expectStatus("GET /console/accounts", "GET", "/console/accounts", 200, { headers: authed });
  await expectStatus("GET /console/settings", "GET", "/console/settings", 200, { headers: authed });

  await expectSseFirstDataLine(
    "/console/telemetry/in-flight/stream",
    "GET /console/telemetry/in-flight/stream (SSE, first data: frame <= 5s)",
  );
  await expectSseHandshake("/console/logs/stream", "GET /console/logs/stream (SSE handshake)");

  await expectStatus("POST /v2/admin/auth/login (must be 404)", "POST", "/v2/admin/auth/login", 404, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "regression-guard", password: "regression-guard" }),
  });
  await expectStatus("GET /console/auth/session without cookie (must be 401)", "GET", "/console/auth/session", 401);
}

function summary(): number {
  const failed = results.filter((result) => !result.passed);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("Failed checks:");
    for (const failure of failed) console.log(`  - ${failure.name}`);
  }
  return failed.length > 0 ? 1 : 0;
}

void (async (): Promise<void> => {
  try {
    await run();
  } catch (error) {
    record("harness", false, errorDetail(error));
  } finally {
    process.exitCode = summary();
  }
})();
