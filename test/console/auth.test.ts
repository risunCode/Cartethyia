import { describe, expect, test } from "bun:test";
import { signConsoleJwt, verifyConsoleJwt } from "../../src/console/auth/jwt";

const SECRET = "test-secret";

describe("console JWT", () => {
  test("sign/verify roundtrip", async () => {
    const token = await signConsoleJwt({ secret: SECRET, pv: 1, ttlSeconds: 60 });
    const result = await verifyConsoleJwt(token, { secret: SECRET, expectedPv: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.role).toBe("admin");
      expect(result.payload.pv).toBe(1);
      expect(result.payload.jti.length).toBeGreaterThan(0);
    }
  });

  test("rejects a tampered signature", async () => {
    const token = await signConsoleJwt({ secret: SECRET, pv: 1, ttlSeconds: 60 });
    const tampered = `${token.slice(0, -2)}${token.endsWith("aa") ? "bb" : "aa"}`;
    const result = await verifyConsoleJwt(tampered, { secret: SECRET, expectedPv: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature");
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await signConsoleJwt({ secret: "other", pv: 1, ttlSeconds: 60 });
    const result = await verifyConsoleJwt(token, { secret: SECRET, expectedPv: 1 });
    expect(result.ok).toBe(false);
  });

  test("rejects an expired token", async () => {
    const token = await signConsoleJwt({ secret: SECRET, pv: 1, ttlSeconds: 10, nowSeconds: 1_000 });
    const result = await verifyConsoleJwt(token, { secret: SECRET, expectedPv: 1, nowSeconds: 2_000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("rejects a stale password_version (logout-all / password change)", async () => {
    const token = await signConsoleJwt({ secret: SECRET, pv: 1, ttlSeconds: 3600 });
    const result = await verifyConsoleJwt(token, { secret: SECRET, expectedPv: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale_pv");
  });

  test("rejects malformed tokens", async () => {
    for (const bad of [undefined, "", "abc", "a.b", "a.b.c.d"]) {
      const result = await verifyConsoleJwt(bad, { secret: SECRET, expectedPv: 1 });
      expect(result.ok).toBe(false);
    }
  });
});
