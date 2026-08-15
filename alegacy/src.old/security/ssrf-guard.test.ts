import { describe, expect, test } from "bun:test";
import {
  MAX_SSRF_URL_LENGTH,
  SsrfGuardError,
  assertPublicUrl,
  assertPublicUrlAtDispatch,
  validatePublicUrl,
} from "./ssrf-guard";

describe("SSRF URL guard", () => {
  test("rejects malformed, unsupported, private, and metadata targets", () => {
    const cases: Array<{ url: string; reason: SsrfGuardError["reason"] }> = [
      { url: "", reason: "invalid_url" },
      { url: "not-a-url", reason: "invalid_url" },
      { url: "ftp://example.com/file", reason: "unsupported_protocol" },
      { url: "http://localhost:12800", reason: "blocked_host" },
      { url: "http://metadata.google.internal/computeMetadata/v1", reason: "blocked_host" },
      { url: "http://127.0.0.1:12800", reason: "blocked_ip" },
      { url: "http://[::1]:12800", reason: "blocked_ip" },
    ];

    for (const entry of cases) {
      try {
        assertPublicUrl(entry.url);
        throw new Error(`Expected ${entry.url} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(SsrfGuardError);
        expect((error as SsrfGuardError).reason).toBe(entry.reason);
      }
    }
  });

  test("accepts public URLs and enforces the input length bound", () => {
    expect(assertPublicUrl("https://example.com/api").hostname).toBe("example.com");
    expect(validatePublicUrl("https://example.com/api")).toBeNull();

    const oversized = `https://example.com/${"x".repeat(MAX_SSRF_URL_LENGTH)}`;
    expect(validatePublicUrl(oversized)).toContain(`${MAX_SSRF_URL_LENGTH} characters`);
  });
  test("fails closed when DNS returns no addresses", async () => {
    await expect(assertPublicUrlAtDispatch("https://service.example/api", {
      lookup: async () => [],
    })).rejects.toMatchObject({ reason: "invalid_url" });
  });

  test("blocks DNS rebinding when any resolved address is private", async () => {
    await expect(assertPublicUrlAtDispatch("https://service.example/api", {
      lookup: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.7" }],
    })).rejects.toMatchObject({ reason: "blocked_ip" });

    await expect(assertPublicUrlAtDispatch("https://service.example/api", {
      lookup: async () => [{ address: "93.184.216.34" }],
    })).resolves.toMatchObject({ hostname: "service.example" });
  });
});
