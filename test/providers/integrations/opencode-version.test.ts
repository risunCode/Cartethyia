import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetOpenCodeVersion,
  getOpenCodeVersion,
  resolveOpenCodeVersion,
} from "../../../src/providers/operations/client-versions";
import {
  buildOpenCodeHeaders,
  generateOpenCodeRequestId,
  generateOpenCodeSessionId,
} from "../../../src/providers/integrations/opencode-fingerprint";
import { jsonResponse } from "../../helpers/sse-fixtures";


describe("OpenCode version and fingerprinting", () => {
  beforeEach(() => {
    _resetOpenCodeVersion();
  });

  afterEach(() => {
    _resetOpenCodeVersion();
  });

  test("generates session ID matching OpenCode binary format (30 chars)", () => {
    const id = generateOpenCodeSessionId();
    expect(id.startsWith("ses_")).toBe(true);
    expect(id.length).toBe(30);
    // ses_ + 12 hex chars + 14 base62 chars
    expect(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id)).toBe(true);
  });

  test("generates unique session IDs on sequential calls", () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateOpenCodeSessionId()));
    expect(ids.size).toBe(10);
  });

  test("generates request ID starting with msg_", () => {
    const reqId = generateOpenCodeRequestId();
    expect(reqId.startsWith("msg_")).toBe(true);
  });

  test("builds headers matching official CLI fingerprint", () => {
    _resetOpenCodeVersion(VERSION_SOURCES.opencode.fallback);
    const headers = buildOpenCodeHeaders();
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(headers["x-opencode-session"]?.startsWith("ses_")).toBe(true);
    expect(headers["x-opencode-session"]?.length).toBe(30);
    expect(headers["x-opencode-request"]?.startsWith("msg_")).toBe(true);
    expect(headers["user-agent"]).toBe(`opencode/${VERSION_SOURCES.opencode.fallback}`);
  });

  test("resolves version from npm registry", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("registry.npmjs.org")
        ? jsonResponse({ version: "1.19.0" })
        : new Response("missing", { status: 404 })) as unknown as typeof fetch;

    await resolveOpenCodeVersion(fetcher);
    expect(getOpenCodeVersion()).toBe("1.19.0");
    const headers = buildOpenCodeHeaders();
    expect(headers["user-agent"]).toBe("opencode/1.19.0");
  });

  test("keeps fallback on network failure", async () => {
    const fetcher = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    await resolveOpenCodeVersion(fetcher);
    expect(getOpenCodeVersion()).toBe(VERSION_SOURCES.opencode.fallback);
  });
});
