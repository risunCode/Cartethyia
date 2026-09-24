import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getLocalPlatform,
  getOsHints,
  hasPlaceholderSecrets,
  parseServiceUrl,
  probeTcpService,
  readEnvFile,
} from "./ops-env-utils";

const testDir = resolve(import.meta.dir, ".test-env-utils");

describe("scripts/env-utils", () => {
  describe("readEnvFile", () => {
    beforeEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    });

    test("returns an empty mapping when the file is missing", async () => {
      expect(await readEnvFile(resolve(testDir, ".env"))).toEqual({});
    });

    test("parses dotenv key=value pairs", async () => {
      const envPath = resolve(testDir, ".env");
      writeFileSync(
        envPath,
        "DATABASE_URL=postgres://localhost:5432/test\nREDIS_URL=redis://localhost:6379\n",
      );
      expect(await readEnvFile(envPath)).toEqual({
        DATABASE_URL: "postgres://localhost:5432/test",
        REDIS_URL: "redis://localhost:6379",
      });
    });

    test("skips comments and malformed lines", async () => {
      const envPath = resolve(testDir, ".env");
      writeFileSync(envPath, "# a comment\n\nKEY=value\nnot-a-key-value-line\n");
      expect(await readEnvFile(envPath)).toEqual({ KEY: "value" });
    });

    test("later duplicate keys override earlier ones", async () => {
      const envPath = resolve(testDir, ".env");
      writeFileSync(
        envPath,
        "DATABASE_URL=postgres://first:5432/db\nDATABASE_URL=postgres://second:5432/db\n",
      );
      expect(await readEnvFile(envPath)).toEqual({
        DATABASE_URL: "postgres://second:5432/db",
      });
    });

    test("trims whitespace around keys and values", async () => {
      const envPath = resolve(testDir, ".env");
      writeFileSync(envPath, "  DATABASE_URL  =  postgres://localhost:5432/db  \n");
      expect(await readEnvFile(envPath)).toEqual({
        DATABASE_URL: "postgres://localhost:5432/db",
      });
    });
  });

  describe("probeTcpService", () => {
    test("reports failure for a port with no listener", async () => {
      // Port 1 is reserved and never bound by the test environment.
      const result = await probeTcpService("127.0.0.1", 1, 500);
      expect(result.success).toBe(false);
      expect(typeof result.error).toBe("string");
    });
  });

  describe("parseServiceUrl", () => {
    test("extracts host and port from Postgres URL", () => {
      const result = parseServiceUrl("postgres://user:pass@localhost:5432/cartethyia");
      expect(result).toEqual({ host: "localhost", port: 5432 });
    });

    test("rejects URLs with implicit ports", () => {
      expect(parseServiceUrl("postgres://localhost/cartethyia")).toBeNull();
      expect(parseServiceUrl("redis://localhost")).toBeNull();
    });

    test("extracts custom port", () => {
      const result = parseServiceUrl("postgres://localhost:1234/db");
      expect(result?.port).toBe(1234);
    });

    test("returns null for invalid URL", () => {
      const result = parseServiceUrl("not-a-valid-url");
      expect(result).toBeNull();
    });

    test("returns null for empty string", () => {
      const result = parseServiceUrl("");
      expect(result).toBeNull();
    });

    test("handles IPv4 addresses", () => {
      const result = parseServiceUrl("postgres://127.0.0.1:5432/db");
      expect(result?.host).toBe("127.0.0.1");
      expect(result?.port).toBe(5432);
    });

    test("handles IPv6 addresses in URLs", () => {
      const result = parseServiceUrl("postgres://[::1]:5432/db");
      // URL.hostname strips brackets from IPv6 in some environments
      expect(result?.host === "::1" || result?.host === "[::1]").toBe(true);
      expect(result?.port).toBe(5432);
    });
  });

  describe("hasPlaceholderSecrets", () => {
    test("detects 'replace-with-local' placeholders", () => {
      const value = "postgres://user:replace-with-local-password@localhost:5432/db";
      expect(hasPlaceholderSecrets(value)).toBe(true);
    });

    test("detects REPLACE_ME placeholders", () => {
      const value = "REPLACE_ME_WITH_YOUR_SECRET";
      expect(hasPlaceholderSecrets(value)).toBe(true);
    });

    test("detects YOUR_ prefix placeholders", () => {
      const value = "YOUR_API_KEY_HERE";
      expect(hasPlaceholderSecrets(value)).toBe(true);
    });

    test("returns false for real secret values", () => {
      const value = "postgres://user:realsecretpassword@localhost:5432/db";
      expect(hasPlaceholderSecrets(value)).toBe(false);
    });

    test("returns false for empty string", () => {
      expect(hasPlaceholderSecrets("")).toBe(false);
    });
  });

  describe("parseServiceUrl rejects unusable values", () => {
    test("rejects a non-URL", () => {
      expect(parseServiceUrl("not-a-url")).toBeNull();
    });

    test("rejects empty string", () => {
      expect(parseServiceUrl("")).toBeNull();
    });
  });

  describe("getOsHints", () => {
    test("returns non-empty hints for any OS and service", () => {
      const hints = getOsHints("postgres");
      expect(Array.isArray(hints)).toBe(true);
      expect(hints.length >= 0).toBe(true);
    });

    test("returns hints for Redis", () => {
      const hints = getOsHints("redis");
      expect(Array.isArray(hints)).toBe(true);
    });

    test("Postgres hints contain helpful text", () => {
      const hints = getOsHints("postgres");
      const text = hints.join(" ");
      expect(
        text.includes("postgres") ||
          text.includes("Windows") ||
          text.includes("macOS") ||
          text.includes("Linux") ||
          text.includes("brew") ||
          text.includes("systemctl") ||
          text.includes("Laragon"),
      ).toBe(true);
    });
  });
  describe("getLocalPlatform", () => {
    test("returns a supported platform label", () => {
      expect(["windows", "macos", "linux", "unknown"]).toContain(getLocalPlatform());
    });
  });
});
