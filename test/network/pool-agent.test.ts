import { describe, expect, test } from "bun:test";
import {
  deriveKind,
  isProxyAgentPair,
  splitEndpointConfig,
  createHttpProxyAgent,
  createSocks5Agent,
  RESERVED_ENDPOINT_CONFIG_KEYS,
} from "../../src/network/pool/agent";

/**
 * Reads an agent's protocol. Node's `http.Agent` does not declare the property
 * (only `https.Agent` does), yet the SOCKS https flavor sets it deliberately so
 * Node accepts that agent for `https:` targets. Reading it through a shape that
 * names what the code intentionally writes keeps the assertion honest without
 * widening the production type.
 */
function agentProtocol(agent: unknown): string | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  const value = (agent as { protocol?: unknown }).protocol;
  return typeof value === "string" ? value : undefined;
}

describe("splitEndpointConfig", () => {
  test("keeps string endpoint and label, forwards every other key as opaque config", () => {
    expect(
      splitEndpointConfig({ endpoint: "http://h:1", label: "L", maxSockets: 5, endpointX: 1 }),
    ).toEqual({
      endpoint: "http://h:1",
      label: "L",
      rest: { maxSockets: 5, endpointX: 1 },
    });
  });

  test("drops a non-string endpoint or label instead of coercing it", () => {
    expect(splitEndpointConfig({ endpoint: 7, label: null, foo: "bar" })).toEqual({
      rest: { foo: "bar" },
    });
  });

  test("an empty config yields an empty rest bag with neither field present", () => {
    expect(splitEndpointConfig({})).toEqual({ rest: {} });
  });

  test("reserves exactly endpoint and label; everything else survives into rest", () => {
    expect(Object.keys(RESERVED_ENDPOINT_CONFIG_KEYS).sort()).toEqual(["endpoint", "label"]);
    const { rest } = splitEndpointConfig({ endpoint: "x", label: "y", endpoint_extra: 1 });
    expect(rest).toEqual({ endpoint_extra: 1 });
  });
});

describe("deriveKind", () => {
  test("promotes an http pool to https only when the endpoint is an https URL", () => {
    expect(deriveKind("http", "https://proxy.example:8443")).toBe("https");
    expect(deriveKind("http", "http://proxy.example:8080")).toBe("http");
  });

  test("passes a non-http db kind through unchanged", () => {
    expect(deriveKind("socks5", "https://ignored.example")).toBe("socks5");
    expect(deriveKind("https", "http://ignored.example")).toBe("https");
  });
});

describe("isProxyAgentPair", () => {
  test("rejects null, non-objects, and objects missing a scheme flavor", () => {
    expect(isProxyAgentPair(null)).toBe(false);
    expect(isProxyAgentPair("http://x")).toBe(false);
    expect(isProxyAgentPair({})).toBe(false);
    expect(isProxyAgentPair({ http: {} })).toBe(false);
    expect(isProxyAgentPair({ http: {}, https: {} })).toBe(false);
  });

  test("accepts a pair carrying one connection factory per scheme", () => {
    expect(
      isProxyAgentPair({
        http: { createConnection: () => undefined },
        https: { createConnection: () => undefined },
      }),
    ).toBe(true);
  });
});

describe("createHttpProxyAgent", () => {
  test("exposes a relayEndpoint only for hosted relay front doors", () => {
    for (const host of [
      "my-app.vercel.app",
      "svc.workers.dev",
      "site.netlify.app",
      "My-App.Vercel.App",
      "my-app.vercel.app.",
    ]) {
      const pair = createHttpProxyAgent(`https://${host}`);
      expect(pair.relayEndpoint?.toString()).toBe(new URL(`https://${host}`).toString());
    }
  });

  test("a plain CONNECT proxy host is not classified as a relay", () => {
    const pair = createHttpProxyAgent("http://127.0.0.1:3128");
    expect(pair.relayEndpoint).toBeUndefined();
    expect(agentProtocol(pair.http)).toBe("http:");
    expect(agentProtocol(pair.https)).toBe("https:");
  });

  test("splits a credential on the first colon and percent-encodes both halves", () => {
    const pair = createHttpProxyAgent("https://my-app.vercel.app", "user:p@ss:word");
    expect(pair.relayEndpoint?.toString()).toBe(
      "https://user:p%40ss%3Aword@my-app.vercel.app/",
    );
  });

  test("a credential without a colon becomes a username with an empty password", () => {
    const pair = createHttpProxyAgent("https://my-app.vercel.app", "justtoken");
    expect(pair.relayEndpoint?.toString()).toBe("https://justtoken@my-app.vercel.app/");
  });

  test("rejects an endpoint that is not a URL", () => {
    expect(() => createHttpProxyAgent("not a url")).toThrow(
      "invalid HTTP proxy endpoint: not a url",
    );
    expect(() => createHttpProxyAgent("")).toThrow("invalid HTTP proxy endpoint: ");
  });
});

describe("createSocks5Agent", () => {
  test("defaults a bare host:port authority to socks5 and gives each flavor its scheme", () => {
    const pair = createSocks5Agent("127.0.0.1:1080");
    expect(isProxyAgentPair(pair)).toBe(true);
    expect(agentProtocol(pair.http)).toBe("http:");
    expect(agentProtocol(pair.https)).toBe("https:");
  });

  test("accepts a socks5 URL carrying credentials", () => {
    const pair = createSocks5Agent("socks5://user:pass@127.0.0.1:1080");
    expect(isProxyAgentPair(pair)).toBe(true);
    expect(agentProtocol(pair.https)).toBe("https:");
  });

  test("a SOCKS pool never carries a relay endpoint, even on a relay-shaped host", () => {
    const pair = createSocks5Agent("socks5://relay.vercel.app:1080");
    expect(pair.relayEndpoint).toBeUndefined();
  });

  test("rejects an authority that cannot be parsed as a URL", () => {
    expect(() => createSocks5Agent(":::")).toThrow("invalid SOCKS5 endpoint: :::");
  });

  test("rejects a non-socks scheme rather than silently dialing it as SOCKS", () => {
    expect(() => createSocks5Agent("http://127.0.0.1:1080")).toThrow(/socks/);
  });
});
