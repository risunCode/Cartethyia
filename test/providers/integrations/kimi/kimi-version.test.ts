import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  VERSION_SOURCES,
  _resetKimiCliVersion,
  getKimiCliVersion,
  resolveKimiCliVersion,
} from "../../../../src/providers/operations/client-versions";
import { jsonResponse } from "../../../helpers/sse-fixtures";


describe("Kimi CLI client version", () => {
  beforeEach(() => {
    _resetKimiCliVersion();
  });

  afterEach(() => {
    _resetKimiCliVersion();
  });

  test("pinned fallback is used before discovery", () => {
    expect(getKimiCliVersion()).toBe(VERSION_SOURCES.kimiCli.fallback);
  });

  test("resolves from the PyPI registry", async () => {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).includes("pypi.org")
        ? jsonResponse({ info: { version: "1.55.0" } })
        : new Response("missing", { status: 404 })) as unknown as typeof fetch;

    await resolveKimiCliVersion(fetcher);
    expect(getKimiCliVersion()).toBe("1.55.0");
  });

  test("keeps the pinned fallback when PyPI fails", async () => {
    const fetcher = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    await resolveKimiCliVersion(fetcher);
    expect(getKimiCliVersion()).toBe(VERSION_SOURCES.kimiCli.fallback);
  });
});