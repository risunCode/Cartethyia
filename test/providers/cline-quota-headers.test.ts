/**
 * Cline's quota headers must state two different versions in two different
 * slots.
 *
 * `x-core-version` is the `@cline/sdk` version — a separate npm package with
 * its own release line. This used to send the *client* version there too, so
 * the billing surface was told our core was `4.1.23`, a VS Code extension
 * version `@cline/sdk` has never published. `src/providers/integrations/cline/
 * cline.ts` has always sent the correct pairing on the chat surface.
 *
 * Why this is not cosmetic: Cline's refusal for an implausible client identity
 * is `Unauthorized: Please make sure you're using the latest version of Cline
 * and re-authenticate your Cline account.` — the same wording it returns for a
 * dead credential. A header the upstream validates is therefore indistinguishable
 * from an auth failure at the response, which is exactly how this presented
 * before: as "the quota endpoint rejected us", pointing an operator at
 * re-authenticating an account whose chat requests were working.
 *
 * The headers are private, so this observes them where they are actually used:
 * the request `fetchClineQuota` issues. A local fetcher captures the headers and
 * returns a minimal valid shape.
 */
import { describe, expect, test } from "bun:test";
import {
  _resetClineClientVersionCache,
  getClineClientVersion,
  getClineSdkVersion,
} from "../../src/providers/operations/client-versions";
import {
  CLINE_API_KEY_PREFIX,
  fetchClineQuota,
} from "../../src/providers/integrations/cline/cline-quota";

/** Captures the headers of the first request and answers with a valid quota shape. */
function capturingFetcher(): {
  readonly fetcher: typeof fetch;
  readonly seen: () => Record<string, string> | undefined;
} {
  let captured: Record<string, string> | undefined;
  const fetcher = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    captured = normalizeHeaders(init?.headers);
    const path = String(url);
    if (path.endsWith("/users/me")) {
      return jsonResponse({ id: "u-1", displayName: "Op" });
    }
    if (path.endsWith("/plan")) {
      return jsonResponse({ plan: { displayName: "Cline Pro" } });
    }
    if (path.endsWith("/usage-limits")) {
      return jsonResponse({ limits: [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
  return { fetcher, seen: () => captured };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** `HeadersInit` is a union; the call site always passes a plain record. */
function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const normalized = new Headers(headers);
  const result: Record<string, string> = {};
  normalized.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

describe("Cline quota headers", () => {
  test("x-core-version is the SDK version, not the client version", async () => {
    // The bug: both slots carried the client version. Asserting the two are
    // *different values* is what catches it — asserting each against its own
    // constant would pass on a regression that swapped the two.
    const clientVersion = getClineClientVersion();
    const sdkVersion = getClineSdkVersion();
    const { fetcher, seen } = capturingFetcher();
    await fetchClineQuota("workos:token", fetcher);
    const headers = seen();
    expect(headers?.["x-client-version"]).toBe(clientVersion);
    expect(headers?.["x-core-version"]).toBe(sdkVersion);
    expect(headers?.["x-core-version"]).not.toBe(headers?.["x-client-version"]);
  });

  test("the SDK version is the one @cline/sdk actually publishes", async () => {
    // A core version no release ever published is the whole defect. The SDK
    // line is 0.0.x while the client is 4.1.x, so the leading major is the
    // property that separates them — asserted structurally rather than pinned,
    // because a real SDK release will move the number.
    const sdkVersion = getClineSdkVersion();
    expect(sdkVersion.startsWith("0.")).toBe(true);
    expect(getClineClientVersion().startsWith("4.")).toBe(true);
  });

  test("the billing surface keeps the CLI identity the chat surface does not use", async () => {
    // `cline.ts` claims `cline-sdk` for chat; the billing endpoints are read by
    // the CLI. Both are correct for their own surface, so this pins the value
    // that must not drift into the chat one.
    const { fetcher, seen } = capturingFetcher();
    await fetchClineQuota("workos:token", fetcher);
    expect(seen()?.["x-client-type"]).toBe("cline-cli");
  });

  test("a resolved version is followed, so the pooler reaches this surface too", async () => {
    // The user's report was that the quota path did not follow the version
    // pooler. It does read the resolver; this is what proves it — seeding a
    // discovered version changes what is sent.
    _resetClineClientVersionCache("9.9.9");
    try {
      const { fetcher, seen } = capturingFetcher();
      await fetchClineQuota("workos:token", fetcher);
      expect(seen()?.["x-client-version"]).toBe("9.9.9");
      expect(seen()?.["user-agent"]).toBe("Cline/9.9.9");
    } finally {
      _resetClineClientVersionCache();
    }
  });

  test("an api-key account never reaches the OAuth-only billing surface", async () => {
    // Unchanged behavior, pinned because the header fix touched this file: a
    // 401 from /models is dispatchable, a 401 from users/me is not.
    let requested: string | undefined;
    const fetcher = (async (url: unknown): Promise<Response> => {
      requested = String(url);
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;
    const result = await fetchClineQuota(`${CLINE_API_KEY_PREFIX}key-123`, fetcher);
    expect(requested?.endsWith("/models")).toBe(true);
    expect(result.error).toBeNull();
  });
});
