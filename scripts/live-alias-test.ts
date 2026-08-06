/**
 * Live end-to-end proof that model aliases resolve through the public proxy
 * dispatch, not just the console. Boots a real server, creates the alias
 * `claude-sonnet-3.5 -> cline/deepseek/deepseek-v4-flash`, then asserts the
 * alias is listed by GET /v1/models and that POST /v1/chat/completions routes
 * to the cline provider (a credential/upstream failure, NOT an "unresolved
 * model" / "model_not_found" error). Also checks proxy auth gating rejects a
 * bad key. Run: bun run scripts/live-alias-test.ts
 */

const port = 13001;
const password = "live-alias-password";
const dataDir = `${process.cwd()}/.tmp-live-alias-${Date.now()}`;
const proxyKey = "sk-live-alias-test-key-0123456789abcdef";

const child = Bun.spawn(["bun", "run", "src/main.ts"], {
  cwd: process.cwd(),
  env: {
    ...Bun.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    CONSOLE_PASSWORD: password,
    CONSOLE_JWT_SECRET: "live-alias-jwt-secret-0123456789",
    PROXY_AUTH_MODE: "api_key",
    BOOTSTRAP_PROXY_API_KEY: proxyKey,
    BOOTSTRAP_PROXY_API_KEY_NAME: "live-alias-test",
    TRACK_PAYLOADS: "none",
  },
  stdout: "ignore",
  stderr: "pipe",
});

const base = `http://127.0.0.1:${port}`;
const results: Array<[string, string, unknown]> = [];

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await Bun.sleep(250);
  }
  throw new Error("server did not become healthy");
}

try {
  await waitForHealth();

  // 1. Console login
  const login = await fetch(`${base}/console/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  results.push(["console login", `status=${login.status}`, await login.text()]);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const consoleHeaders = { cookie, "content-type": "application/json" };

  // 2. Create the alias claude-sonnet-3.5 -> cline/deepseek/deepseek-v4-flash
  const create = await fetch(`${base}/console/api/aliases`, {
    method: "POST",
    headers: consoleHeaders,
    body: JSON.stringify({ alias: "claude-sonnet-3.5", model: "cline/deepseek/deepseek-v4-flash" }),
  });
  results.push(["create alias", `status=${create.status}`, await create.text()]);

  // Confirm it is stored
  const list = await fetch(`${base}/console/api/aliases`, { headers: { cookie } });
  const listed = (await list.json()) as { items: Array<{ alias: string; model: string }> };
  results.push([
    "alias listed in console",
    `status=${list.status}`,
    `aliases=${JSON.stringify(listed.items?.find((a) => a.alias === "claude-sonnet-3.5") ?? null)}`,
  ]);

  // 3. Proxy auth: a bad key must be rejected
  const badAuth = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-3.5", messages: [{ role: "user", content: "hi" }] }),
  });
  results.push(["bad proxy key rejected", `status=${badAuth.status}`, await badAuth.text()]);

  // 4. Model listing shows the alias (resolve via GET /v1/models)
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${proxyKey}` } });
  const modelBody = (await models.json()) as { data?: Array<{ id: string }> };
  const ids = (modelBody.data ?? []).map((m) => m.id);
  results.push([
    "alias appears in GET /v1/models",
    `status=${models.status}`,
    `ids_contain_alias=${ids.includes("claude-sonnet-3.5")}`,
  ]);

  // 5. Dispatch with the alias model via the public API. No Cline OAuth
  // credential exists, so this must fail with a credential/upstream error —
  // NOT an "unresolved model" or "model_not_found", which would prove the
  // alias did NOT flow through dispatch.
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${proxyKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-3.5", messages: [{ role: "user", content: "hi" }] }),
  });
  const chatText = await chat.text();
  const chatBody = (() => {
    try {
      return JSON.parse(chatText) as Record<string, unknown>;
    } catch {
      return { raw: chatText };
    }
  })();
  const message = JSON.stringify(chatBody.error ?? chatBody);
  const resolvedInDispatch =
    chat.status !== 200 &&
    !/unresolved|model_not_found|does not support|no such model/i.test(message) &&
    /credential|authentication|oauth|account|route|not found/i.test(message);

try {
  await waitForHealth();

  // 1. Console login
  const login = await fetch(`${base}/console/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  results.push(["console login", `status=${login.status}`, await login.text()]);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const consoleHeaders = { cookie, "content-type": "application/json" };

  // 2. Create the alias claude-sonnet-3.5 -> cline/deepseek/deepseek-v4-flash
  const create = await fetch(`${base}/console/api/aliases`, {
    method: "POST",
    headers: consoleHeaders,
    body: JSON.stringify({ alias: "claude-sonnet-3.5", model: "cline/deepseek/deepseek-v4-flash" }),
  });
  results.push(["create alias", `status=${create.status}`, await create.text()]);

  // Confirm it is stored
  const list = await fetch(`${base}/console/api/aliases`, { headers: { cookie } });
  const listed = (await list.json()) as { items: Array<{ alias: string; model: string }> };
  results.push([
    "alias listed in console",
    `status=${list.status}`,
    `found=${JSON.stringify(listed.items?.find((a) => a.alias === "claude-sonnet-3.5") ?? null)}`,
  ]);

  // 3. Proxy auth: a bad key must be rejected
  const badAuth = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-key", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-3.5", messages: [{ role: "user", content: "hi" }] }),
  });
  results.push(["bad proxy key rejected", `status=${badAuth.status}`, await badAuth.text()]);

  // 4. Model listing shows the alias (resolve via GET /v1/models)
  const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${proxyKey}` } });
  const modelBody = (await models.json()) as { data?: Array<{ id: string }> };
  const ids = (modelBody.data ?? []).map((m) => m.id);
  results.push([
    "alias appears in GET /v1/models",
    `status=${models.status}`,
    `ids_contain_alias=${ids.includes("claude-sonnet-3.5")}`,
  ]);

  // 5. Dispatch with the alias model via the public API. No Cline OAuth
  // credential exists, so this must fail with a credential/upstream error —
  // NOT an "unresolved model" or "model_not_found", which would prove the
  // alias did NOT flow through dispatch.
  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${proxyKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-3.5", messages: [{ role: "user", content: "hi" }] }),
  });
  const chatText = await chat.text();
  const chatBody = (() => {
    try {
      return JSON.parse(chatText) as Record<string, unknown>;
    } catch {
      return { raw: chatText };
    }
  })();
  const message = JSON.stringify(chatBody.error ?? chatBody);
  const resolvedInDispatch =
    chat.status !== 200 &&
    !/unresolved|model_not_found|does not support|no such model/i.test(message) &&
    /credential|authentication|oauth|account|route|not found/i.test(message);
  results.push([
    "alias routes to cline provider via dispatch",
    `status=${chat.status}`,
    `resolved_in_dispatch=${resolvedInDispatch} body=${message}`,
  ]);

  console.log(JSON.stringify({ results }, null, 2));
} finally {
  child.kill();
  await child.exited;
  await Bun.$`rm -rf ${dataDir}`;
}

  results.push([
    "alias routes to cline provider via dispatch",
    `status=${chat.status}`,
    `resolved_in_dispatch=${resolvedInDispatch} body=${message}`,
  ]);

  console.log(JSON.stringify({ ok: results.every(([, , body]) => typeof body === "string" ? !/unresolved/i.test(body) : true), results }, null, 2));
} finally {
  child.kill();
  await child.exited;
  await Bun.$`rm -rf ${dataDir}`;
}

