/** Shared console test helpers: isolated DATA_DIR + login cookie. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { app } from "../../src/app";
import { closeDbForTests } from "../../src/console/db/client";
import { resetBootstrapForTests } from "../../src/console/bootstrap";
import { resetCredentialKeyForTests } from "../../src/console/crypto/credential-key";
import { loginLimiter } from "../../src/console/auth/limiter";
import { resetRuntimeSettingsForTests } from "../../src/console/runtime";
import { resetProxyAuthForTests } from "../../src/console/proxy-auth";
import { resetConsoleLogsForTests } from "../../src/console/logs/ring";
import { clearRuntimeUsageForTests } from "../../src/console/db/repos/usage";

export function useIsolatedDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cth-console-"));
  Bun.env.DATA_DIR = dir;
  Bun.env.PROXY_AUTH_MODE = "open";
  closeDbForTests();
  resetBootstrapForTests();
  resetCredentialKeyForTests();
  loginLimiter.resetAll();
  resetRuntimeSettingsForTests();
  resetProxyAuthForTests();
  resetConsoleLogsForTests();
  clearRuntimeUsageForTests();
  return dir;
}

export function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

export async function loginAndGetCookie(password = "carte1234"): Promise<string> {
  const res = await app.handle(postJson("/console/api/login", { password }));
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}
