interface ValidationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const checks: ValidationCheck[] = [];
const baseUrl = "http://localhost:8080";
const consolePassword = process.env.CONSOLE_PASSWORD ?? "";

function addCheck(name: string, passed: boolean, detail?: string): void {
  checks.push({ name, passed, ...(detail === undefined ? {} : { detail }) });
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function responseDetail(response: Response, body: string): string {
  const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return `HTTP ${response.status}${excerpt.length > 0 ? `: ${excerpt}` : ""}`;
}

async function bringUp(): Promise<boolean> {
  try {
    const process = Bun.spawn(
      ["docker", "compose", "up", "-d", "postgres", "redis", "cartethyia", "dashboard", "--wait"],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) {
      addCheck("compose-up", false, stderr.trim() || `docker compose exited with code ${exitCode}`);
      return false;
    }
    addCheck("compose-up", true);
    return true;
  } catch (error) {
    addCheck("compose-up", false, errorDetail(error));
    return false;
  }
}

async function checkLandingPage(): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();
    addCheck(
      "landing-page",
      response.status === 200 && body.includes("<title>Cartethyia"),
      response.status === 200 && body.includes("<title>Cartethyia")
        ? undefined
        : responseDetail(response, body),
    );
  } catch (error) {
    addCheck("landing-page", false, errorDetail(error));
  }
}

async function login(): Promise<string> {
  if (consolePassword.length === 0) {
    addCheck("auth-login", false, "CONSOLE_PASSWORD is not set");
    return "";
  }
  try {
    const response = await fetch(`${baseUrl}/console/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: consolePassword, remember: true }),
    });
    const body = await response.text();
    const setCookie = response.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0] ?? "";
    const passed = response.status === 200 && cookie.length > 0;
    addCheck("auth-login", passed, passed ? undefined : responseDetail(response, body));
    return passed ? cookie : "";
  } catch (error) {
    addCheck("auth-login", false, errorDetail(error));
    return "";
  }
}

async function checkJsonEndpoint(path: string, cookie: string): Promise<void> {
  const name = `json-${path.split("/").filter(Boolean).pop() ?? "endpoint"}`;
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: cookie.length > 0 ? { cookie } : undefined,
    });
    const body = await response.text();
    if (response.status !== 200) {
      addCheck(name, false, responseDetail(response, body));
      return;
    }
    try {
      JSON.parse(body);
      addCheck(name, true);
    } catch (error) {
      addCheck(name, false, `HTTP 200 but response was not JSON: ${errorDetail(error)}`);
    }
  } catch (error) {
    addCheck(name, false, errorDetail(error));
  }
}

async function checkConsoleLogStream(cookie: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/v2/admin/console/logs/stream`, {
      headers: cookie.length > 0 ? { cookie } : undefined,
      signal: controller.signal,
    });
    if (response.status !== 200 || response.body === null) {
      const body = await response.text();
      addCheck("console-log-sse", false, responseDetail(response, body));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedFrame = false;
    try {
      while (!receivedFrame) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        receivedFrame = buffer.split("\n").some((line) => line.startsWith("data:") || line.startsWith(":"));
      }
    } finally {
      await reader.cancel();
    }
    addCheck(
      "console-log-sse",
      receivedFrame,
      receivedFrame ? undefined : "Timed out or stream closed without a data frame or keep-alive comment",
    );
  } catch (error) {
    addCheck(
      "console-log-sse",
      false,
      controller.signal.aborted ? "Timed out after 10 seconds" : errorDetail(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function printReport(): void {
  console.log("\nFull-stack validation report");
  for (const check of checks) {
    const status = check.passed ? "PASS" : "FAIL";
    console.log(`${status} ${check.name}${check.detail === undefined ? "" : ` — ${check.detail}`}`);
  }
}

async function main(): Promise<void> {
  const stackReady = await bringUp();
  if (stackReady) {
    await checkLandingPage();
    const cookie = await login();
    await Promise.all([
      checkJsonEndpoint("/console/api/dashboard", cookie),
      checkJsonEndpoint("/console/api/telemetry/usage", cookie),
      checkJsonEndpoint("/console/api/telemetry/providers", cookie),
    ]);
    await checkConsoleLogStream(cookie);
  }
}

try {
  await main();
} catch (error) {
  addCheck("harness", false, errorDetail(error));
} finally {
  printReport();
  process.exit(checks.some((check) => !check.passed) ? 1 : 0);
}
