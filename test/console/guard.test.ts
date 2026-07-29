import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

beforeEach(() => {
  useIsolatedDataDir();
});

describe("console guard", () => {
  test("rejects requests without a session cookie", async () => {
    const res = await app.handle(new Request("http://localhost/console/api/keys"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  test("rejects a tampered session cookie", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      new Request("http://localhost/console/api/keys", { headers: { cookie: `${cookie}x` } })
    );
    expect(res.status).toBe(401);
  });

  test("rejects mutating calls without JSON content-type", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      new Request("http://localhost/console/api/keys", {
        method: "POST",
        headers: { "content-type": "text/plain", cookie },
        body: "name=x",
      })
    );
    expect(res.status).toBe(403);
  });

  test("rejects cross-origin mutating calls", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      postJson("/console/api/keys", { name: "x-key" }, { cookie, origin: "http://evil.example" })
    );
    expect(res.status).toBe(403);
  });

  test("allows same-origin mutating calls", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(
      postJson("/console/api/keys", { name: "ok-key" }, { cookie, origin: "http://localhost" })
    );
    expect(res.status).toBe(201);
  });

  test("login rate limiter locks after repeated failures", async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.handle(postJson("/console/api/login", { password: "wrong" }));
      last = res.status;
    }
    expect(last).toBe(429);
    const body = (await (await app.handle(postJson("/console/api/login", { password: "wrong" }))).json()) as {
      retryAfterSec: number;
    };
    expect(body.retryAfterSec).toBeGreaterThan(0);
  });
});
