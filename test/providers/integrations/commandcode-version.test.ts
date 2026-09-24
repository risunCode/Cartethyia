import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetCommandCodeVersion,
  getCommandCodeVersion,
  resolveCommandCodeVersion,
} from "../../../src/providers/operations/client-versions";
import { jsonResponse } from "../../helpers/sse-fixtures";


describe("CommandCode client version", () => {
  beforeEach(() => {
    _resetCommandCodeVersion();
  });

  afterEach(() => {
    _resetCommandCodeVersion();
  });

  test("pinned fallback is used before discovery", () => {
    expect(getCommandCodeVersion()).toBe(VERSION_SOURCES.commandcode.fallback);
    expect(VERSION_SOURCES.commandcode.fallback).toBe("1.64.0");
  });

  test("resolves from the npm registry", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("registry.npmjs.org")
        ? jsonResponse({ version: "1.60.0" })
        : new Response("missing", { status: 404 })) as unknown as typeof fetch;

    await resolveCommandCodeVersion(fetcher);
    expect(getCommandCodeVersion()).toBe("1.60.0");
  });

  test("keeps the pinned fallback when the registry fails", async () => {
    const fetcher = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    await resolveCommandCodeVersion(fetcher);
    expect(getCommandCodeVersion()).toBe(VERSION_SOURCES.commandcode.fallback);
  });
});