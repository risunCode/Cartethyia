import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createStaticHandler } from "../../src/console/dashboard-assets";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";

describe("Console Static Handler", () => {
  let testDir: string;
  let handler: ReturnType<typeof createStaticHandler>;

  beforeAll(async () => {
    testDir = "/tmp/console-static-test-" + Date.now();
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, "assets"), { recursive: true });
    await writeFile(join(testDir, "assets", "app.abc123.js"), "console.log('app');");
    await writeFile(join(testDir, "index.html"), "<html><body>Dashboard</body></html>");
    handler = createStaticHandler({ buildDir: testDir });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("Path Traversal Prevention", () => {
    it("rejects .. traversal", async () => {
      const result = await handler("/console/../../../etc/passwd");
      expect(result.status).toBe(404);
      expect(result.body).toBeUndefined();
    });

    it("rejects encoded .. traversal", async () => {
      const result = await handler("/console/%2e%2e/etc/passwd");
      expect(result.status).toBe(404);
    });

    it("rejects backslash traversal", async () => {
      const result = await handler("/console/..\\..\\etc\\passwd");
      expect(result.status).toBe(404);
    });

    it("rejects absolute paths", async () => {
      const result = await handler("/console//etc/passwd");
      expect(result.status).toBe(404);
    });
  });

  describe("API Path Rejection", () => {
    it("rejects /console/api/* paths", async () => {
      const result = await handler("/console/api/users");
      expect(result.status).toBe(404);
      expect(result.body).toBeUndefined();
    });

    it("does not return HTML for /console/api/*", async () => {
      const result = await handler("/console/api/v1/data");
      expect(result.status).toBe(404);
      expect(result.headers["content-type"]).not.toContain("text/html");
    });
  });

  describe("Hashed Asset Serving", () => {
    it("serves hashed asset with immutable cache", async () => {
      const result = await handler("/console/assets/app.abc123.js");
      expect(result.status).toBe(200);
      expect(result.body).toBeDefined();
      expect(result.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(result.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    });
  });

  describe("index.html and SPA Routes", () => {
    it("serves index.html with no-cache", async () => {
      const result = await handler("/console/index.html");
      expect(result.status).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");
      expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
    });

    it("serves the shared index document at the public root", async () => {
      const result = await handler("/");
      expect(result.status).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");
      expect(new TextDecoder().decode(result.body)).toContain("<body>Dashboard</body>");
    });

    it("serves index.html for extensionless SPA routes", async () => {
      const result = await handler("/console/dashboard");
      expect(result.status).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");
    });

    it("serves index.html for nested extensionless SPA routes", async () => {
      // Nested client-side routes (e.g. /cli-tools/:toolId) have no matching
      // file on disk and no extension — a real SPA fallback must still serve
      // index.html so react-router can resolve the route client-side, at any
      // path depth, not just single-segment routes.
      const result = await handler("/console/cli-tools/claude");
      expect(result.status).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-cache, must-revalidate");
      expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
    });
  });

  describe("Missing Assets", () => {
    it("returns 404 for missing .js file", async () => {
      const result = await handler("/console/assets/missing.js");
      expect(result.status).toBe(404);
    });

    it("returns 404 for missing .css file", async () => {
      const result = await handler("/console/missing.css");
      expect(result.status).toBe(404);
    });
  });

  describe("Path Decoding", () => {
    it("handles URL-encoded paths", async () => {
      const spaceFile = join(testDir, "file with space.txt");
      await writeFile(spaceFile, "test content");
      const result = await handler("/console/file%20with%20space.txt");
      expect(result.status).toBe(200);
    });

    it("rejects invalid URL encoding", async () => {
      const result = await handler("/console/%GG/invalid");
      expect(result.status).toBe(404);
    });
  });

  describe("MIME Types", () => {
    it("sets JavaScript MIME type", async () => {
      const result = await handler("/console/assets/app.abc123.js");
      expect(result.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    });

    it("sets HTML MIME type", async () => {
      const result = await handler("/console/index.html");
      expect(result.headers["content-type"]).toBe("text/html; charset=utf-8");
    });
  });

  describe("Security Headers", () => {
    it("sets a hashed-script CSP on HTML responses", async () => {
      const result = await handler("/console/index.html");
      const csp = result.headers["content-security-policy"] ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(result.headers["x-frame-options"]).toBe("DENY");
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("sets the locked-down API CSP on non-document assets", async () => {
      const result = await handler("/console/assets/app.abc123.js");
      expect(result.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(result.headers["x-frame-options"]).toBe("DENY");
    });

    it("hashes inline scripts so scripts never need 'unsafe-inline'", async () => {
      await writeFile(
        join(testDir, "index.html"),
        "<html><body><script>boot()</script></body></html>",
      );
      const result = await handler("/console/index.html");
      const csp = result.headers["content-security-policy"] ?? "";
      expect(csp).toContain("'sha256-");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    });
  });

  describe("No HTML for API Requests", () => {
    it("does not serve HTML for API paths", async () => {
      const result = await handler("/console/api/dashboard");
      expect(result.status).toBe(404);
      expect(result.body).toBeUndefined();
    });
  });
});
