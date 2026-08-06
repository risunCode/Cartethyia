const port = 12999;
const dataDir = `${process.cwd()}/.tmp-console-smoke-${Date.now()}`;
const password = "cartethyia-smoke-password";
const processHandle = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: { ...Bun.env, PORT: String(port), DATA_DIR: dataDir, CONSOLE_PASSWORD: password, CONSOLE_JWT_SECRET: "cartethyia-smoke-secret-123456789" },
  stdout: "ignore",
  stderr: "pipe",
});

const base = `http://127.0.0.1:${port}`;
const waitForHealth = async (): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error("runtime did not become healthy");
};

const cookieHeader = (response: Response): string => response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

try {
  await waitForHealth();
  const login = await fetch(`${base}/console/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = cookieHeader(login);
  if (!cookie) throw new Error("login did not return a session cookie");
  const headers = { cookie };
  for (const path of ["/console/api/live/in-flight", "/console/api/console-logs"]) {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  }
  const stream = await fetch(`${base}/console/api/live/in-flight/stream`, { headers, signal: AbortSignal.timeout(1_000) });
  if (stream.status !== 200 || !stream.body) throw new Error(`in-flight stream failed: ${stream.status}`);
  await stream.body.cancel();
  const clear = await fetch(`${base}/console/api/console-logs`, { method: "DELETE", headers: { ...headers, origin: base, "content-type": "application/json" }, body: "{}" });
  if (!clear.ok) throw new Error(`console log clear failed: ${clear.status}`);
  console.log("console integration smoke passed");
} finally {
  processHandle.kill();
  await processHandle.exited;
  await Bun.$`rm -rf ${dataDir}`;
}
