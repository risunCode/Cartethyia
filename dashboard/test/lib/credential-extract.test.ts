import { describe, expect, test } from "bun:test";
import {
  assignAccountNames,
  detectCredentialKind,
  extractCredentialFromPaste,
  parseCredentialBatch,
} from "../../src/lib/credential-extract";

describe("detectCredentialKind", () => {
  test("classifies a plain API key string as api_key", () => {
    expect(detectCredentialKind("sk-abc123def456")).toBe("api_key");
  });

  test("classifies a JSON OAuth export with access+refresh+expires as oauth", () => {
    const json = JSON.stringify({
      access: "eyJhbGciOi...",
      refresh: "rt-abc123",
      expires: 1735689600000,
      accountId: "acc_1",
      email: "user@example.com",
    });
    expect(detectCredentialKind(json)).toBe("oauth");
  });

  test("classifies a JSON blob with only an apiKey field as api_key (no refresh/expiry shape)", () => {
    const json = JSON.stringify({ apiKey: "sk-live-xyz" });
    expect(detectCredentialKind(json)).toBe("api_key");
  });

  test("classifies key:value line-based OAuth exports as oauth", () => {
    const lines = "access: tok-123\nrefresh: rt-456\nexpires: 1735689600000";
    expect(detectCredentialKind(lines)).toBe("oauth");
  });

  test("defaults to api_key for unrecognized plain text", () => {
    expect(detectCredentialKind("just a random paste")).toBe("api_key");
  });
});

describe("extractCredentialFromPaste", () => {
  test("extracts the access token from a nested data field", () => {
    const json = JSON.stringify({ id: "x", data: JSON.stringify({ access: "extracted-token" }) });
    const result = extractCredentialFromPaste(json);
    expect(result.extracted).toBe(true);
    expect(result.value).toBe("extracted-token");
    expect(result.source).toBe("data.access");
  });

  test("prefers the highest-priority field when multiple candidates exist", () => {
    const json = JSON.stringify({ token: "should-not-win", access: "should-win" });
    const result = extractCredentialFromPaste(json);
    expect(result.value).toBe("should-win");
    expect(result.source).toBe("access");
  });

  test("returns the raw trimmed text unextracted when no structured shape matches", () => {
    const result = extractCredentialFromPaste("  sk-plain-key-123  ");
    expect(result.extracted).toBe(false);
    expect(result.value).toBe("sk-plain-key-123");
  });
});

describe("parseCredentialBatch", () => {
  test("returns no entries for empty input", () => {
    expect(parseCredentialBatch("   ")).toEqual([]);
  });

  test("a single plain API key is one api_key entry with no identity", () => {
    const entries = parseCredentialBatch("sk-test-123");
    expect(entries).toEqual([{ value: "sk-test-123", kind: "api_key" }]);
  });

  test("a single whole-blob JSON OAuth export is one oauth entry carrying the full JSON and identity", () => {
    const record = { access: "tok", refresh: "rt", expires: 1, email: "a@example.com" };
    const entries = parseCredentialBatch(JSON.stringify(record));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("oauth");
    expect(entries[0]?.identity).toBe("a@example.com");
    expect(JSON.parse(entries[0]?.value ?? "")).toEqual(record);
  });

  test("a JSON array of OAuth records becomes one entry per element, tracking each identity", () => {
    const records = [
      { access: "t1", refresh: "r1", expires: 1, email: "one@example.com" },
      { access: "t2", refresh: "r2", expires: 2, accountId: "acc-2" },
    ];
    const entries = parseCredentialBatch(JSON.stringify(records));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.identity).toBe("one@example.com");
    expect(entries[1]?.identity).toBe("acc-2");
    expect(entries.every((e) => e.kind === "oauth")).toBe(true);
  });

  test("newline-delimited plain tokens become one api_key entry per non-empty line", () => {
    const entries = parseCredentialBatch("sk-one\nsk-two\n\nsk-three");
    expect(entries).toEqual([
      { value: "sk-one", kind: "api_key" },
      { value: "sk-two", kind: "api_key" },
      { value: "sk-three", kind: "api_key" },
    ]);
  });

  test("newline-delimited JSON objects become one entry per line", () => {
    const line1 = JSON.stringify({ apiKey: "sk-a", email: "a@example.com" });
    const line2 = JSON.stringify({ apiKey: "sk-b", email: "b@example.com" });
    const entries = parseCredentialBatch(`${line1}\n${line2}`);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ value: "sk-a", kind: "api_key", identity: "a@example.com" });
    expect(entries[1]).toEqual({ value: "sk-b", kind: "api_key", identity: "b@example.com" });
  });

  test("a multi-line key:value block describing one credential is not split into a batch", () => {
    const entries = parseCredentialBatch(
      "access: tok\nrefresh: rt\nexpires: 1\nemail: a@example.com",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("oauth");
    expect(entries[0]?.identity).toBe("a@example.com");
  });
});

describe("assignAccountNames", () => {
  test("uses the detected identity as the name when present", () => {
    const entries = parseCredentialBatch(
      JSON.stringify([{ access: "t", refresh: "r", expires: 1, email: "user@example.com" }]),
    );
    expect(assignAccountNames(entries, "codex", [])).toEqual(["user@example.com"]);
  });

  test("falls back to providerId-N for entries with no identity, skipping existing names", () => {
    const entries = parseCredentialBatch("sk-one\nsk-two\nsk-three");
    expect(assignAccountNames(entries, "openai", ["openai-1"])).toEqual([
      "openai-2",
      "openai-3",
      "openai-4",
    ]);
  });

  test("suffixes colliding identities to keep every name unique", () => {
    const record = { apiKey: "sk-a", email: "dup@example.com" };
    const entries = parseCredentialBatch(`${JSON.stringify(record)}\n${JSON.stringify(record)}`);
    expect(assignAccountNames(entries, "openai", ["dup@example.com"])).toEqual([
      "dup@example.com (2)",
      "dup@example.com (3)",
    ]);
  });
});
