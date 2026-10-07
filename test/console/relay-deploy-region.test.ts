/**
 * Where a hosted relay is deployed.
 *
 * The region decides which country outbound traffic leaves from, so the two
 * things worth pinning are the default and that a chosen region actually reaches
 * Vercel. The second one has a trap: a `regions` field on the *deployment* is
 * accepted and echoed back, but the Function still runs wherever the *project*
 * is pinned — measured, which is why this asserts on the project PATCH and not
 * on the deployment payload alone.
 *
 * Deploys are stubbed; `deployRelay`, its validation, and its URL handling are
 * the real ones.
 */
import { describe, expect, test } from "bun:test";
import { deployRelay } from "../../src/console/routing/pools/relay-deploy";
import { DEFAULT_RELAY_REGION, RELAY_REGIONS, isRelayRegion } from "../../src/console/routing/pools/relay-regions";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body?: string;
}

/** Records every call so the suite can assert on what was actually sent. */
function recorder(): { calls: Call[]; fetchImpl: (url: string, init: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url,
      method: init.method ?? "GET",
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    if (url.includes("/projects/")) return new Response("{}", { status: 200 });
    if (url.includes("/deployments")) {
      return new Response(JSON.stringify({ url: "relay-abc.vercel.app" }), { status: 200 });
    }
    // Cloudflare reads the workers.dev subdomain after uploading the script.
    if (url.includes("/workers/subdomain")) {
      return new Response(JSON.stringify({ result: { subdomain: "example.workers.dev" } }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("the default region", () => {
  test("Singapore is the default, so egress does not silently land in the US", () => {
    expect(DEFAULT_RELAY_REGION).toBe("sin1");
  });

  test("every shipped region is a known Vercel id", () => {
    expect(RELAY_REGIONS.length).toBeGreaterThan(10);
    expect(RELAY_REGIONS).toContain("sin1");
    expect(RELAY_REGIONS).toContain("iad1");
    for (const region of RELAY_REGIONS) expect(isRelayRegion(region)).toBe(true);
  });

  test("an unknown string is not a region", () => {
    expect(isRelayRegion("sin1")).toBe(true);
    expect(isRelayRegion("SIN1")).toBe(false);
    expect(isRelayRegion("atlantis-1")).toBe(false);
    expect(isRelayRegion(undefined)).toBe(false);
  });
});

describe("deployRelay sends the region", () => {
  test("the chosen region is set on the Vercel project", async () => {
    const { calls, fetchImpl } = recorder();
    await deployRelay(fetchImpl, { target: "vercel", token: "t", region: "hkg1" });
    const patches = calls.filter((call) => call.url.includes("/projects/") && call.method === "PATCH");
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      const parsed = JSON.parse(patch.body ?? "{}") as { serverlessFunctionRegion?: string };
      expect(parsed.serverlessFunctionRegion).toBe("hkg1");
    }
  });

  test("no region given still pins the default, never leaves it unset", async () => {
    const { calls, fetchImpl } = recorder();
    await deployRelay(fetchImpl, { target: "vercel", token: "t" });
    const patches = calls.filter((call) => call.url.includes("/projects/") && call.method === "PATCH");
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      const parsed = JSON.parse(patch.body ?? "{}") as { serverlessFunctionRegion?: string };
      expect(parsed.serverlessFunctionRegion).toBe(DEFAULT_RELAY_REGION);
    }
  });

  test("an unrecognized region falls back to the default instead of being sent raw", async () => {
    // A junk value sent through would be rejected by Vercel, and the operator
    // would see a deploy failure naming a region they never chose.
    const { calls, fetchImpl } = recorder();
    await deployRelay(fetchImpl, { target: "vercel", token: "t", region: "atlantis-1" });
    const patches = calls.filter((call) => call.url.includes("/projects/") && call.method === "PATCH");
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      const parsed = JSON.parse(patch.body ?? "{}") as { serverlessFunctionRegion?: string };
      expect(parsed.serverlessFunctionRegion).toBe(DEFAULT_RELAY_REGION);
    }
  });

  test("a region is not sent to a target that has no region control", async () => {
    // Cloudflare Workers runs at the edge nearest the caller; sending a region
    // would be a control that does nothing, and a PATCH to a project that does
    // not exist would be a wasted call.
    const { calls, fetchImpl } = recorder();
    await deployRelay(fetchImpl, {
      target: "cloudflare",
      token: "t",
      accountId: "acct",
      region: "sin1",
    });
    expect(calls.some((call) => call.url.includes("vercel.com"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/projects/"))).toBe(false);
  });
});
