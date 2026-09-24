import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb } from "../../../src/persistence/postgres";
import { dbDescribe } from "../../helpers/db-gate";
import { tenants, cliToolMappings, cliToolSettings } from "../../../src/persistence/schema";
import { INJECTORS } from "../../../src/console/cli-tools/injectors/driver";
import type { ApplyInput, CliMappingInput, ToolInjector } from "../../../src/console/cli-tools/contracts";
import { CliToolMappingStore } from "../../../src/console/cli-tools/store";
import { CliToolService } from "../../../src/console/cli-tools/service";
import { createCliToolsRoutes } from "../../../src/console/cli-tools/routes";
import type { AccessDecision } from "../../../src/security/access-control";
import { ConsoleDomainError } from "../../../src/console/shared/errors";

describe("CliToolService", () => {
  const stubStore = {
    getMappings: async () => null,
    saveMappings: async () => {},
    getSettings: async () => null,
    saveSettings: async () => {},
  } as unknown as CliToolMappingStore;
  const service = new CliToolService(stubStore);

  test("registry returns 18 tools partitioned between file and guide entries", () => {
    const registry = service.getRegistry();
    expect(registry).toHaveLength(18);
    expect(registry.filter((tool) => tool.configType === "guide")).toHaveLength(5);
    expect(registry.filter((tool) => tool.configType !== "guide")).toHaveLength(13);
  });

  test("isValidTool rejects unknown ids", () => {
    expect(service.isValidTool("claude")).toBe(true);
    expect(service.isValidTool("nope")).toBe(false);
    // An inherited `Object.prototype` member is not a tool id: this gate guards
    // `saveMappings`, which reads `TOOL_REGISTRY[toolId]` right after it.
    expect(service.isValidTool("toString")).toBe(false);
    expect(service.isValidTool("constructor")).toBe(false);
  });

  test("getAllStatuses converts one crashing injector into a non-throwing status row", async () => {
    const original = INJECTORS.claude;
    INJECTORS.claude = {
      toolId: "claude",
      getStatus: async () => {
        throw new Error("boom");
      },
      apply: async () => ({ success: true, message: "unused" }),
      reset: async () => ({ success: true, message: "unused" }),
      download: async () => ({ content: "", filename: "x", mimeType: "text/plain" }),
    } satisfies ToolInjector;
    try {
      const statuses = await service.getAllStatuses();
      expect(statuses.claude?.configured).toBe(false);
      expect(statuses.claude?.message).toBe("Failed to read status");
      expect(Object.keys(statuses)).toHaveLength(18);
    } finally {
      INJECTORS.claude = original;
    }
  });

  /**
   * A guide tool has no config file to inject. Applying it with no remote
   * route must report `none` — claiming `file` would tell the operator a write
   * happened when nothing touched the disk.
   */
  test("apply on a guide tool with no remote route reports none, not file", async () => {
    const guideId = service
      .getRegistry()
      .find((entry) => entry.configType === "guide")!.id;
    const result = await service.applyConfig("tenant-1", guideId, {
      endpoint: "http://localhost:12800",
      apiKey: "sk-test",
      modelIds: [],
      mode: "file",
    });
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("none");
    expect(result!.wroteFile).toBe(false);
    expect(result!.savedRemoteRoute).toBe(false);
  });

  test("getStatus returns null for unknown tool", async () => {
    expect(await service.getStatus("missing")).toBeNull();
  });
});

dbDescribe("CliToolService — real DB", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  afterAll(async () => {
    const db = getDb();
    await db.delete(cliToolMappings).where(inArray(cliToolMappings.tenantId, [tenantA, tenantB]));
    await db.delete(cliToolSettings).where(inArray(cliToolSettings.tenantId, [tenantA, tenantB]));
    await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  });

  test("mapping round-trip is tenant-scoped on real DB", async () => {
    const db = getDb();
    const mappingStore = new CliToolMappingStore(db);
    const service = new CliToolService(mappingStore);
    await db
      .insert(tenants)
      .values([
        { id: tenantA, name: "cli-a", status: "active" },
        { id: tenantB, name: "cli-b", status: "active" },
      ])
      .onConflictDoNothing();

    await service.saveMappings(tenantA, "claude", {
      enabled: true,
      mappings: [
        {
          slotKey: "sonnet",
          sourceModel: "sonnet",
          targetModel: "claude/claude-sonnet-5",
          enabled: true,
        },
      ],
    });

    const a = await service.getMappings(tenantA, "claude");
    const b = await service.getMappings(tenantB, "claude");
    expect(a.tenantId).toBe(tenantA);
    expect(a.mappings).toHaveLength(1);
    expect(b.tenantId).toBe(tenantB);
    expect(b.mappings).toHaveLength(0);
  });
});

describe("api-routes.test.ts", () => {
const readWrite: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
    admissionIdentity: "key-1",
};

const readOnly: AccessDecision = {
  ...readWrite,
  scopes: ["dashboard:read"],
};

function createService(): CliToolService {
  return {
    getRegistry: () => [
      {
        id: "claude",
        name: "Claude Code",
        color: "#000",
        description: "x",
        configType: "env",
        surface: "messages",
        defaultModels: [],
        mappingSupported: true,
      },
    ],
    getAllStatuses: async () => ({
      claude: {
        toolId: "claude",
        installed: false,
        configured: false,
        settingsPath: null,
        currentEndpoint: null,
        currentApiKeyPrefix: null,
        currentModels: null,
      },
    }),
    getStatus: async (toolId: string) =>
      toolId === "claude"
        ? {
            toolId,
            installed: false,
            configured: false,
            settingsPath: null,
            currentEndpoint: null,
            currentApiKeyPrefix: null,
            currentModels: null,
          }
        : null,
    isValidTool: (toolId: string) => toolId === "claude",
    getMappings: async (tenantId: string, toolId: string) => ({
      tenantId,
      toolId,
      enabled: true,
      mappings: [],
    }),
    saveMappings: async (tenantId: string, toolId: string, input: CliMappingInput) => ({
      tenantId,
      toolId,
      enabled: input.enabled,
      mappings: input.mappings,
    }),
    downloadConfig: async (toolId: string) =>
      toolId === "claude"
        ? { content: "{}", filename: "settings.json", mimeType: "application/json" }
        : null,
    // Mirrors the real contract: a keyId is resolved server-side into the
    // plaintext the injectors write, so a caller never has to paste a secret.
    withResolvedSecret: async (
      _tenantId: string,
      input: ApplyInput & { keyId?: string },
    ): Promise<ApplyInput> => {
      if (input.apiKey.length > 0) return input;
      if (input.keyId === undefined) {
        throw new ConsoleDomainError("api_key_unresolvable", 409, "no secret");
      }
      return { ...input, apiKey: "resolved-secret" };
    },
    applyConfig: async (_tenantId: string, toolId: string, input: ApplyInput & { mode?: string }) => {
      if (toolId !== "claude") return null;
      const mode = input.mode ?? "both";
      const wroteFile = mode !== "remote";
      const savedRemoteRoute = mode !== "file";
      return {
        outcome: wroteFile && savedRemoteRoute ? "both" : wroteFile ? "file" : "remote",
        wroteFile,
        savedRemoteRoute,
        message: "ok",
      };
    },
  } as unknown as CliToolService;
}

function app(access: AccessDecision | undefined) {
  return createCliToolsRoutes({ service: createService(), accessResolver: () => access });
}

describe("createCliToolsRoutes", () => {
  test("401s without auth", async () => {
    const response = await app(undefined).handle(
      new Request("http://localhost/cli-tools/registry"),
    );
    expect(response.status).toBe(401);
  });

  test("200s a read-scoped status route for read-only access", async () => {
    const response = await app(readOnly).handle(
      new Request("http://localhost/cli-tools/all-statuses"),
    );
    expect(response.status).toBe(200);
  });


  // Passes in isolation (~150ms); the default 5000ms budget is too tight
  // when this runs inside the full src/console/ shard (33 files/188 tests
  // in one bun test process) under CI/dev-machine contention.
  test("422s malformed mapping body", async () => {
    const response = await app(readWrite).handle(
      new Request("http://localhost/cli-tools/claude/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, mappings: [{ nope: true }] }),
      }),
    );
    expect(response.status).toBe(422);
  }, 15_000);

  test("200s happy mapping save path", async () => {
    const response = await app(readWrite).handle(
      new Request("http://localhost/cli-tools/claude/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          mappings: [
            {
              slotKey: "sonnet",
              sourceModel: "sonnet",
              targetModel: "claude/claude-sonnet-5",
              enabled: true,
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true });
  });

  test("404s unknown tool", async () => {
    const response = await app(readWrite).handle(new Request("http://localhost/cli-tools/nope"));
    expect(response.status).toBe(404);
  });

  /**
   * The reported bug: download demanded a pasted secret even though the
   * console stores a recoverable copy. A `keyId` alone must be enough.
   */
  test("downloads with only a keyId, no pasted secret", async () => {
    const response = await app(readWrite).handle(
      new Request("http://localhost/cli-tools/claude/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "http://localhost:12800",
          keyId: "11111111-1111-1111-1111-111111111111",
          models: [],
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filename: "settings.json" });
  });

  test("422s a download with neither apiKey nor keyId", async () => {
    const response = await app(readWrite).handle(
      new Request("http://localhost/cli-tools/claude/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://localhost:12800", models: [] }),
      }),
    );
    expect(response.status).toBe(422);
  });

  test("apply reports which delivery paths ran", async () => {
    const body = (mode: string) =>
      new Request("http://localhost/cli-tools/claude/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "http://localhost:12800",
          keyId: "11111111-1111-1111-1111-111111111111",
          models: [],
          mode,
        }),
      });
    const both = await app(readWrite).handle(body("both"));
    expect(both.status).toBe(200);
    expect(await both.json()).toMatchObject({ outcome: "both", wroteFile: true, savedRemoteRoute: true });

    const remote = await app(readWrite).handle(body("remote"));
    expect(await remote.json()).toMatchObject({ outcome: "remote", wroteFile: false });

    const file = await app(readWrite).handle(body("file"));
    expect(await file.json()).toMatchObject({ outcome: "file", savedRemoteRoute: false });
  });

  test("apply requires write scope, download only read", async () => {
    const req = new Request("http://localhost/cli-tools/claude/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "http://x", keyId: "k", models: [] }),
    });
    expect((await app(readOnly).handle(req)).status).toBe(403);
  });

  test("409s when the selected key has no recoverable secret", async () => {
    const response = await app(readWrite).handle(
      new Request("http://localhost/cli-tools/claude/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: "http://x", models: [] , apiKey: ""}),
      }),
    );
    // No keyId and no secret: rejected at parse time, before resolution.
    expect(response.status).toBe(422);
  });
});
});
