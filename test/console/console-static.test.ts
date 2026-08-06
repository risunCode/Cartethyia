import { describe, expect, test } from "bun:test";
import { resolveConsoleStatic } from "../../src/console/static";

describe("console static resolution", () => {
  const assets = new Set(["dashboard/dist/assets/index.js"]);
  const exists = async (file: string): Promise<boolean> => assets.has(file);

  test("serves the SPA entry for console root and deep links", async () => {
    await expect(resolveConsoleStatic("/console/", exists)).resolves.toEqual({ kind: "entry", file: "dashboard/dist/index.html" });
    await expect(resolveConsoleStatic("/console/login", exists)).resolves.toEqual({ kind: "entry", file: "dashboard/dist/index.html" });
    await expect(resolveConsoleStatic("/console/overview", exists)).resolves.toEqual({ kind: "entry", file: "dashboard/dist/index.html" });
  });

  test("serves known assets and rejects missing or unsafe assets", async () => {
    await expect(resolveConsoleStatic("/console/assets/index.js", exists)).resolves.toEqual({ kind: "asset", file: "dashboard/dist/assets/index.js" });
    await expect(resolveConsoleStatic("/console/assets/missing.js", exists)).resolves.toEqual({ kind: "not-found" });
    await expect(resolveConsoleStatic("/console/assets/%2E%2E/index.html", exists)).resolves.toEqual({ kind: "not-found" });
    await expect(resolveConsoleStatic("/console/assets/%5Csecret", exists)).resolves.toEqual({ kind: "not-found" });
  });

  test("does not claim non-console routes", async () => {
    await expect(resolveConsoleStatic("/console/api/overview", exists)).resolves.toEqual({ kind: "not-found" });
    await expect(resolveConsoleStatic("/v1/models", exists)).resolves.toEqual({ kind: "not-found" });
  });
});
