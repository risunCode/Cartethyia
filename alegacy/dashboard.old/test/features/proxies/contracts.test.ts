import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  normalizeProxy,
  normalizeProxyTestResult,
  sanitizeProbeDetail,
  toProxyInput,
  validateProxyInput,
} from "../../../src/features/proxies/contracts";

const daemon = vi.hoisted(() => ({
  daemonDelete: vi.fn(),
  daemonGet: vi.fn(),
  daemonPatch: vi.fn(),
  daemonPost: vi.fn(),
}));

vi.mock("../../../src/lib/daemon-api", () => ({
  daemonDelete: daemon.daemonDelete,
  daemonGet: daemon.daemonGet,
  daemonPatch: daemon.daemonPatch,
  daemonPost: daemon.daemonPost,
  daemonFailure: (error: unknown) => ({ code: "unavailable", message: error instanceof Error ? error.message : "unavailable", degraded: true }),
  DaemonContractError: class DaemonContractError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
}));

import { deleteProxy, getProxySettings, importProxies, testProxy } from "../../../src/features/proxies/api";
import { proxyMutationState } from "../../../src/features/proxies/queries";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proxy contracts", () => {
  test("drops password and unknown metadata from rendered records", () => {
    const record = normalizeProxy({
      id: "proxy-1",
      label: "Primary",
      protocol: "http",
      host: "proxy.example",
      port: 8080,
      username: "operator",
      password: "do-not-render",
      metadata: { password: "also-do-not-render" },
      enabled: true,
    });
    expect(record).toEqual(expect.objectContaining({ id: "proxy-1", host: "proxy.example", port: 8080 }));
    expect(record).not.toHaveProperty("password");
    expect(record).not.toHaveProperty("metadata");
  });

  test("sanitizes credentials in bounded probe detail", () => {
    const detail = sanitizeProbeDetail("GET https://alice:s3cret@example.test failed authorization: Bearer-secret; token=abc123");
    expect(detail).toBe("GET https://[redacted]@example.test failed authorization=[redacted]; token=[redacted]");
    expect(normalizeProxyTestResult({ reachable: false, detail: "password=hunter2" }).detail).toBe("password=[redacted]");
  });

  test("validates required fields before a write and omits blank secrets", () => {
    expect(validateProxyInput({ label: "", protocol: "", host: "", port: 0 })).toMatchObject({ valid: false });
    expect(toProxyInput({ label: " Main ", protocol: "http", host: " proxy.example ", port: 8080 })).toEqual({
      label: "Main",
      protocol: "http",
      host: "proxy.example",
      port: 8080,
      enabled: true,
    });
    expect(toProxyInput({ label: "Main", protocol: "http", host: "proxy.example", port: 8080, password: "write-only" })).toHaveProperty("password", "write-only");
  });
});

describe("proxy mutations", () => {
  test("requires deletion confirmation and uses the V2 route", async () => {
    await expect(deleteProxy("proxy-1", { confirmed: false })).rejects.toThrow("confirmation");
    expect(daemon.daemonDelete).not.toHaveBeenCalled();
    daemon.daemonDelete.mockResolvedValue(undefined);
    await deleteProxy("proxy-1", { confirmed: true });
    expect(daemon.daemonDelete).toHaveBeenCalledWith("/proxies/proxy-1");
  });

  test("validates and confirms bulk import before mutation", async () => {
    const input = { label: "Imported", protocol: "http", host: "proxy.example", port: 8080 };
    await expect(importProxies([input], { confirmed: false })).rejects.toThrow("confirmation");
    expect(daemon.daemonPost).not.toHaveBeenCalled();
    daemon.daemonPost.mockResolvedValue({ succeeded: 1, failed: 0, errors: [] });
    await expect(importProxies([input], { confirmed: true })).resolves.toEqual({ succeeded: 1, failed: 0, errors: [] });
    expect(daemon.daemonPost).toHaveBeenCalledWith("/proxies/import", { proxies: [{ label: "Imported", protocol: "http", host: "proxy.example", port: 8080, enabled: true }] });
  });

  test("keeps unavailable outbound policy explicit instead of falling back", async () => {
    daemon.daemonGet.mockRejectedValue(new Error("outbound policy unavailable"));
    await expect(getProxySettings()).rejects.toThrow("outbound policy unavailable");
    expect(daemon.daemonPost).not.toHaveBeenCalled();
  });

  test("does not report stale or unavailable mutations as success", () => {
    expect(proxyMutationState("success", undefined, true)).toEqual({ status: "stale", message: "daemon state refresh pending" });
    expect(proxyMutationState("error", new Error("daemon unavailable"))).toMatchObject({ status: "unavailable" });
  });

  test("sanitizes a successful connectivity mutation", async () => {
    daemon.daemonPost.mockResolvedValue({ reachable: true, latencyMs: 12, detail: "authorization=secret" });
    await expect(testProxy("proxy-1")).resolves.toMatchObject({ reachable: true, latencyMs: 12, detail: "authorization=[redacted]" });
    expect(daemon.daemonPost).toHaveBeenCalledWith("/proxies/proxy-1/test");
  });
});
