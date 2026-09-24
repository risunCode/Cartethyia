import { describe, expect, test } from "bun:test";
import { codexJwtAccountId } from "../../../src/providers/quota/quota-contracts";

function jwt(payload: unknown): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${segment}.signature`;
}

/**
 * `codexJwtAccountId` reads its claims through the shared `decodeJwtPayload`.
 * It used to carry its own `atob(seg.replace(/-/g, "+").replace(/_/g, "/"))`
 * decoder, which is the one place in the repo that base64-decoded to a Latin-1
 * string rather than UTF-8. These pin the field precedence and the token-shape
 * rejections, so the swap cannot have changed which account a token maps to.
 */
describe("codexJwtAccountId", () => {
  test("prefers the nested auth claim, then the flat ones, in that order", () => {
    expect(
      codexJwtAccountId(
        jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "nested" },
          chatgpt_account_id: "flat",
          account_id: "fallback",
        }),
      ),
    ).toBe("nested");
    expect(codexJwtAccountId(jwt({ chatgpt_account_id: "flat", account_id: "fallback" }))).toBe("flat");
    expect(codexJwtAccountId(jwt({ account_id: "fallback" }))).toBe("fallback");
  });

  test("returns null for a token with no account claim", () => {
    expect(codexJwtAccountId(jwt({ other: "value" }))).toBeNull();
    expect(codexJwtAccountId(jwt({ "https://api.openai.com/auth": {} }))).toBeNull();
  });

  test("returns null for a non-string account claim", () => {
    expect(codexJwtAccountId(jwt({ account_id: 12345 }))).toBeNull();
  });

  test("returns null for a token that is not three dot-separated parts", () => {
    expect(codexJwtAccountId("not-a-jwt")).toBeNull();
    expect(codexJwtAccountId("a.b")).toBeNull();
    expect(codexJwtAccountId("a.b.c.d")).toBeNull();
  });

  test("returns null for a payload segment that is not JSON", () => {
    expect(codexJwtAccountId("h.bm90LWpzb24.s")).toBeNull();
  });

  test("reads a claim that follows multi-byte UTF-8 in the payload", () => {
    // The reason the local `atob` decoder was replaced: `atob` yields Latin-1,
    // so a payload containing multi-byte UTF-8 decoded to mojibake. The claim
    // read here is ASCII, but the segment around it is not — a decoder that
    // mangles the bytes before it can still mis-slice the object.
    expect(codexJwtAccountId(jwt({ note: "🎉 日本語", account_id: "acct-after-utf8" }))).toBe(
      "acct-after-utf8",
    );
  });
});
