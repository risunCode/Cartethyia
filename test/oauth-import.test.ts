import { describe, expect, test } from "bun:test";
import { importOAuthCredential } from "../src/shared/oauthImport";

describe("OAuth account JSON import", () => {
  test("converts an OMP Codex export into a Cartethyia bundle", () => {
    const result = importOAuthCredential("openai-codex", JSON.stringify({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_786_185_154_564,
      accountId: "account-1",
      email: "operator@example.com",
      planType: "plus",
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle).toMatchObject({
      version: 1,
      provider: "openai-codex",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessExpiresAt: 1_786_185_154_564,
      accountId: "account-1",
      email: "operator@example.com",
      planType: "plus",
    });
  });

  test("converts a Cline OAuth export", () => {
    const result = importOAuthCredential("cline", JSON.stringify({
      accessToken: "cline-access",
      refreshToken: "cline-refresh",
      expiresAt: "2030-01-01T00:00:00.000Z",
      email: "operator@example.com",
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle).toMatchObject({ provider: "cline", accessToken: "cline-access", refreshToken: "cline-refresh", email: "operator@example.com" });
  });

  test("accepts an existing Cartethyia bundle and rejects provider mismatch", () => {
    const bundle = JSON.stringify({
      version: 1,
      provider: "anthropic-oauth",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      accessExpiresAt: Date.now() + 60_000,
    });
    expect(importOAuthCredential("anthropic-oauth", bundle).ok).toBe(true);
    const mismatch = importOAuthCredential("openai-codex", bundle);
    expect(mismatch).toEqual({ ok: false, reason: "credential belongs to provider 'anthropic-oauth'" });
  });

  test("rejects incomplete exports", () => {
    expect(importOAuthCredential("openai-codex", JSON.stringify({ access: "only-access" }))).toEqual({
      ok: false,
      reason: "OAuth JSON must include accessToken/access, refreshToken/refresh, and expiresAt/expires",
    });
  });
});
