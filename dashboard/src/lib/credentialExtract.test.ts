import { describe, expect, test } from "vitest";
import { extractCredentialFromPaste } from "./credentialExtract";

describe("extractCredentialFromPaste — JSON input", () => {
  test("extracts 'access' field from a flat JSON object (highest priority)", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ access: "tok_abc123", other: "ignored" }));
    expect(result).toEqual({ value: "tok_abc123", extracted: true, source: "access" });
  });

  test("extracts 'accessToken' when 'access' is absent", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ accessToken: "at_xyz" }));
    expect(result).toEqual({ value: "at_xyz", extracted: true, source: "accessToken" });
  });

  test("extracts 'access_token' (snake_case variant)", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ access_token: "sk-abc" }));
    expect(result).toEqual({ value: "sk-abc", extracted: true, source: "access_token" });
  });

  test("extracts 'apiKey' field", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ apiKey: "api-key-123" }));
    expect(result).toEqual({ value: "api-key-123", extracted: true, source: "apiKey" });
  });

  test("extracts 'api_key' (snake_case variant)", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ api_key: "api-key-456" }));
    expect(result).toEqual({ value: "api-key-456", extracted: true, source: "api_key" });
  });

  test("extracts 'token' field when higher-priority fields are absent", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ token: "bearer-token" }));
    expect(result).toEqual({ value: "bearer-token", extracted: true, source: "token" });
  });

  test("extracts 'key' field at lower priority", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ key: "k-value" }));
    expect(result).toEqual({ value: "k-value", extracted: true, source: "key" });
  });

  test("extracts 'pat' field", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ pat: "ghp_PatValue" }));
    expect(result).toEqual({ value: "ghp_PatValue", extracted: true, source: "pat" });
  });

  test("extracts 'secret' field (lowest priority)", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ secret: "my-secret-val" }));
    expect(result).toEqual({ value: "my-secret-val", extracted: true, source: "secret" });
  });

  test("respects priority — 'access' wins over 'token' when both present", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ token: "lower", access: "higher" }));
    expect(result).toEqual({ value: "higher", extracted: true, source: "access" });
  });

  test("extracts nested 'data.access' when top-level fields are missing", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ data: { access: "nested-tok" } }));
    expect(result).toEqual({ value: "nested-tok", extracted: true, source: "data.access" });
  });

  test("extracts nested 'data.token' from a stringified 'data' field", () => {
    const result = extractCredentialFromPaste(
      JSON.stringify({ data: JSON.stringify({ token: "nested-in-string" }) }),
    );
    expect(result).toEqual({ value: "nested-in-string", extracted: true, source: "data.token" });
  });

  test("skips empty strings — does not extract blank credential fields", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ access: "", token: "fallback" }));
    expect(result).toEqual({ value: "fallback", extracted: true, source: "token" });
  });

  test("skips whitespace-only strings as values", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ access: "   ", token: "real" }));
    expect(result).toEqual({ value: "real", extracted: true, source: "token" });
  });

  test("falls back to raw text when JSON has no recognized fields", () => {
    const result = extractCredentialFromPaste(JSON.stringify({ foo: "bar", baz: 42 }));
    expect(result).toEqual({ value: JSON.stringify({ foo: "bar", baz: 42 }), extracted: false });
  });

  test("handles invalid JSON gracefully — falls back to raw text", () => {
    const result = extractCredentialFromPaste("{not valid json}");
    expect(result).toEqual({ value: "{not valid json}", extracted: false });
  });
});

describe("extractCredentialFromPaste — key:value line input", () => {
  test("parses 'access: value' from multi-line text", () => {
    const result = extractCredentialFromPaste("access: tok_from_lines\nother: irrelevant");
    expect(result).toEqual({ value: "tok_from_lines", extracted: true, source: "access" });
  });

  test("parses 'token: value' from single line", () => {
    const result = extractCredentialFromPaste("token: bearer-line-val");
    expect(result).toEqual({ value: "bearer-line-val", extracted: true, source: "token" });
  });

  test("trims surrounding whitespace from parsed key:value", () => {
    const result = extractCredentialFromPaste("  token  :   spaced-value  ");
    expect(result).toEqual({ value: "spaced-value", extracted: true, source: "token" });
  });

  test("returns raw text when no key:value lines match known fields", () => {
    const result = extractCredentialFromPaste("unknown_field: some-value\nanother: thing");
    expect(result).toEqual({ value: "unknown_field: some-value\nanother: thing", extracted: false });
  });
});

describe("extractCredentialFromPaste — plain text fallback", () => {
  test("returns trimmed raw text when input is a bare credential string", () => {
    const result = extractCredentialFromPaste("  sk-plain-credential  ");
    expect(result).toEqual({ value: "sk-plain-credential", extracted: false });
  });

  test("empty string returns empty string, extracted: false", () => {
    const result = extractCredentialFromPaste("");
    expect(result).toEqual({ value: "", extracted: false });
  });

  test("whitespace-only input returns empty string, extracted: false", () => {
    const result = extractCredentialFromPaste("   ");
    expect(result).toEqual({ value: "", extracted: false });
  });
});
