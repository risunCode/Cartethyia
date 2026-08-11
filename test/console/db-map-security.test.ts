import { describe, expect, test } from "bun:test";
import { createDbMapApi } from "../../src/console/db-map/api-routes";

describe("database map sensitive operations", () => {
  test("rejects raw export when step-up verification is absent", async () => {
    const app = createDbMapApi(null);
    const response = await app.handle(new Request("http://localhost/db-map/export?db=config"));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized", message: "password re-authentication is required for database export" } });
  });

  test("requires the console password for both export and import", async () => {
    const received: unknown[] = [];
    const app = createDbMapApi(null, {
      verifySensitiveOperation: async (password) => {
        received.push(password);
        return password === "correct-password";
      },
    });
    const deniedExport = await app.handle(new Request("http://localhost/db-map/export?db=config", { headers: { "x-console-password": "wrong-password" } }));
    const deniedImport = await app.handle(new Request("http://localhost/db-map/import?db=config", { method: "POST", body: new Uint8Array([1, 2, 3]), headers: { "x-console-password": "wrong-password" } }));
    const acceptedExport = await app.handle(new Request("http://localhost/db-map/export?db=config", { headers: { "x-console-password": "correct-password" } }));

    expect(deniedExport.status).toBe(401);
    expect(deniedImport.status).toBe(401);
    expect(acceptedExport.status).not.toBe(401);
    expect(received).toEqual(["wrong-password", "wrong-password", "correct-password"]);
  });
});
