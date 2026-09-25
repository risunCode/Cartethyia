import { afterEach, describe, expect, test } from "bun:test";

import { fetchQuotaOverview, type QuotaOverview } from "../../src/lib/hooks/quota";
import { jsonResponse } from "../helpers/test-helpers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type RouteHandler = (path: string, init?: RequestInit) => Promise<Response>;

function installQuotaFetch(handler: RouteHandler): { seenSignals: Array<AbortSignal | null>; paths: string[] } {
  const seenSignals: Array<AbortSignal | null> = [];
  const paths: string[] = [];
  const fetchMock = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      paths.push(String(input));
      seenSignals.push(init?.signal ?? null);
      return handler(String(input), init);
    },
    { preconnect: originalFetch.preconnect },
  );
  globalThis.fetch = fetchMock;
  return { seenSignals, paths };
}

const overviewPayload: QuotaOverview = {
  providers: [{ id: "anthropic", name: "Anthropic", icon: "anthropic" }],
  accounts: [
    {
      id: "acc-1",
      provider: "anthropic",
      name: "main",
      credentialHint: "oauth",
      active: true,
      quota: {
        source: "upstream",
        status: "ready",
        plan: "pro",
        windows: [
          {
            kind: "monthly",
            label: "Monthly",
            remainingPercent: 62,
            usedPercent: 38,
            resetsAt: null,
          },
        ],
        fetchedAt: "2026-09-05T00:00:00.000Z",
        lastAttemptAt: null,
        lastSuccessAt: "2026-09-05T00:00:00.000Z",
        error: null,
      },
      health: { status: "active", statusCode: 200, sanitizedMessage: null },
      providerName: "Anthropic",
      providerIcon: "anthropic",
    },
  ],
};

function healthyRoute(): { seenSignals: Array<AbortSignal | null>; paths: string[] } {
  return installQuotaFetch(async (path) => {
    if (path === "/console/api/quota/overview") return jsonResponse(overviewPayload);
    throw new Error(`unexpected quota request: ${path}`);
  });
}

describe("fetchQuotaOverview", () => {
  test("loads the server-joined provider/account projection with one request", async () => {
    const { paths } = healthyRoute();

    const overview = await fetchQuotaOverview();

    expect(paths).toEqual(["/console/api/quota/overview"]);
    expect(overview).toEqual(overviewPayload);
  });

  test("propagates authorization failures from the overview endpoint", async () => {
    installQuotaFetch(async (path) => {
      expect(path).toBe("/console/api/quota/overview");
      return jsonResponse({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
    });

    const failure = await fetchQuotaOverview().then(
      () => null,
      (error: unknown) => error as { status: number },
    );
    expect(failure?.status).toBe(401);
  });

  test("propagates server failures instead of fabricating empty quota data", async () => {
    installQuotaFetch(async () => jsonResponse({ error: { code: "internal_error", message: "failed" } }, 500));

    const failure = await fetchQuotaOverview().then(
      () => null,
      (error: unknown) => error as { status: number },
    );
    expect(failure?.status).toBe(500);
  });

  test("threads the React Query abort signal into the overview request", async () => {
    const { seenSignals } = healthyRoute();
    const controller = new AbortController();

    await fetchQuotaOverview(controller.signal);

    expect(seenSignals).toEqual([controller.signal]);
  });
});
