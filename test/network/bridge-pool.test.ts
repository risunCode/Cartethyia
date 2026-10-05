/**
 * The `bridge` pool transport, exercised against real sockets.
 *
 * A `bridge` pool is a carte-bridge front door. Where the front door's runtime
 * holds a raw socket it answers RFC CONNECT and the pool tunnels like any HTTP
 * proxy; on the serverless runtimes it cannot, and the pool must fall back to
 * the bridge's own header-based relay form instead of failing the request.
 *
 * That preference-then-fallback is the whole behaviour, and it can only be
 * proven against a live peer: a mock fetch would assert the branch was chosen,
 * not that a real CONNECT handshake was attempted and its refusal correctly
 * reinterpreted. So both servers here are real: a plain HTTP upstream that
 * records the headers it received, and a bridge front door whose CONNECT
 * handling is switched between "tunnel", "refuse with a status", and "reset
 * the socket" to drive each path of the fetcher.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { createValidatedFetch } from "../../src/network/outbound-fetch";
import {
  createBridgeAgent,
  normalizeBridgeEndpoint,
  ProxyConnectHandshakeError,
  ProxyConnectRefusalError,
  shouldFallbackToBridgeRelay,
} from "../../src/network/pool/agent";
import type { SsrfPolicy } from "../../src/config";

/** Loopback is the only host a test may dial, so the policy must allow it. */
const LOOPBACK_POLICY: SsrfPolicy = { allowPrivate: true };

interface Listening {
  readonly server: Server;
  readonly port: number;
}

function listen(server: Server): Promise<Listening> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function close(listening: Listening): Promise<void> {
  return new Promise((resolve) => listening.server.close(() => resolve()));
}

/**
 * The upstream the bridge is asked to reach. It answers with the request's
 * `Authorization` header echoed back, so a test can prove the provider
 * credential crossed the bridge intact rather than being consumed by it.
 */
function createUpstream(): Server {
  return createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, auth }));
  });
}

/** How a bridge front door answers a CONNECT attempt. */
type ConnectBehaviour = "tunnel" | "refuse" | "reset";

/** Counts how a bridge was reached, so a test can prove *which* path ran. */
interface BridgeStats {
  connects: number;
  relays: number;
}

/**
 * A stand-in carte-bridge: a CONNECT tunnel when told to, an HTTP `?url=` relay
 * otherwise. The relay branch mirrors the real bridge — it reads the absolute
 * target out of the `url` query parameter, fetches it, and streams the answer
 * back — so the fallback path is exercised end to end, not stubbed.
 *
 * The returned `stats` distinguishes the two paths, which is what lets the
 * "tunnels via CONNECT" test assert the tunnel actually carried the request
 * rather than the relay quietly serving it.
 */
function createBridge(
  behaviour: ConnectBehaviour,
  expectedBridgeAuth?: string,
): { server: Server; stats: BridgeStats } {
  const stats: BridgeStats = { connects: 0, relays: 0 };
  const server = createServer(async (req, res) => {
    stats.relays += 1;
    const targetOrigin = req.headers["x-bridge-target"];
    const rawTargetPath = req.headers["x-bridge-path"];
    const targetPath = typeof rawTargetPath === "string" ? rawTargetPath : "/";
    if (typeof targetOrigin !== "string" || !targetOrigin) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing_bridge_target" }));
      return;
    }
    if (expectedBridgeAuth && req.headers["x-bridge-auth"] !== expectedBridgeAuth) {
      res.writeHead(401);
      res.end();
      return;
    }
    const target = new URL(targetPath, targetOrigin);
    const upstreamHeaders = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (
        value === undefined ||
        name === "x-bridge-target" ||
        name === "x-bridge-path" ||
        name === "x-bridge-auth"
      ) continue;
      upstreamHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    upstreamHeaders.set("host", target.host);
    const upstream = await fetch(target, {
      method: req.method ?? "GET",
      headers: upstreamHeaders,
    });
    const body = await upstream.arrayBuffer();
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    });
    res.end(Buffer.from(body));
  });

  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    stats.connects += 1;
    if (behaviour === "refuse") {
      clientSocket.write("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    if (behaviour === "reset") {
      clientSocket.destroy();
      return;
    }
    // Real tunnel: parse `host:port` and pipe both directions.
    const target = req.url ?? "";
    const separator = target.lastIndexOf(":");
    const host = separator === -1 ? target : target.slice(0, separator);
    const port = separator === -1 ? 443 : Number.parseInt(target.slice(separator + 1), 10);
    const upstream = netConnect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });

  return { server, stats };
}

let upstream: Listening;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = await listen(createUpstream());
  upstreamUrl = `http://127.0.0.1:${upstream.port}/v1/messages`;
});

afterAll(async () => {
  await close(upstream);
});

/** Builds a fetcher bound to a bridge front door with the given CONNECT behaviour. */
async function fetchThroughBridge(behaviour: ConnectBehaviour, credentials?: string) {
  const expectedBridgeAuth = credentials
    ? `Basic ${Buffer.from(credentials).toString("base64")}`
    : undefined;
  const { server, stats } = createBridge(behaviour, expectedBridgeAuth);
  const bridge = await listen(server);
  const userinfo = credentials
    ? credentials
        .split(":")
        .map((part) => encodeURIComponent(part))
        .join(":") + "@"
    : "";
  const endpoint = `http://${userinfo}127.0.0.1:${bridge.port}`;
  const agent = createBridgeAgent(endpoint, undefined, LOOPBACK_POLICY);
  const fetchFn = createValidatedFetch({ agent, policy: LOOPBACK_POLICY });
  return { bridge, fetchFn, stats };
}

describe("bridge pool transport", () => {
  test("tunnels via CONNECT when the front door supports it", async () => {
    const { bridge, fetchFn, stats } = await fetchThroughBridge("tunnel");
    try {
      const response = await fetchFn(upstreamUrl, {
        method: "GET",
        headers: { authorization: "Bearer sk-ant-EXAMPLE" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { path: string; auth: string };
      expect(body.path).toBe("/v1/messages");
      // The provider credential crossed the tunnel untouched: the upstream saw
      // the caller's own header, not a bridge-supplied one.
      expect(body.auth).toBe("Bearer sk-ant-EXAMPLE");
      // And it really was the tunnel — not a silent relay — that carried it.
      expect(stats.connects).toBe(1);
      expect(stats.relays).toBe(0);
    } finally {
      await close(bridge);
    }
  });

  test("falls back to the header relay when the front door refuses CONNECT with a status", async () => {
    const { bridge, fetchFn, stats } = await fetchThroughBridge("refuse");
    try {
      const response = await fetchFn(upstreamUrl, {
        method: "GET",
        headers: { authorization: "Bearer sk-ant-EXAMPLE" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { path: string; auth: string };
      expect(body.path).toBe("/v1/messages");
      expect(body.auth).toBe("Bearer sk-ant-EXAMPLE");
      // CONNECT was attempted first, refused, and the relay served the request.
      expect(stats.connects).toBe(1);
      expect(stats.relays).toBe(1);
    } finally {
      await close(bridge);
    }
  });

  test("falls back to the header relay when the front door resets the CONNECT socket", async () => {
    const { bridge, fetchFn, stats } = await fetchThroughBridge("reset");
    try {
      const response = await fetchFn(upstreamUrl, {
        method: "GET",
        headers: { authorization: "Bearer sk-ant-EXAMPLE" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { path: string; auth: string };
      expect(body.auth).toBe("Bearer sk-ant-EXAMPLE");
      expect(stats.connects).toBe(1);
      expect(stats.relays).toBe(1);
    } finally {
      await close(bridge);
    }
  });

  test("sends bridge credentials separately from provider authorization", async () => {
    const { bridge, fetchFn, stats } = await fetchThroughBridge("refuse", "pool-user:pool-pass");
    try {
      const response = await fetchFn(upstreamUrl, {
        method: "GET",
        headers: { authorization: "Bearer sk-ant-EXAMPLE" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { auth: string };
      expect(body.auth).toBe("Bearer sk-ant-EXAMPLE");
      expect(stats.connects).toBe(1);
      expect(stats.relays).toBe(1);
    } finally {
      await close(bridge);
    }
  });
});

describe("bridge endpoint normalization", () => {
  test("folds the bridge:// marker to an https URL", () => {
    // `new URL("bridge://host")` parses with a `bridge:` protocol, which would
    // be dialed as plaintext HTTP. The marker is an input convention, so it must
    // never survive to a dial.
    expect(normalizeBridgeEndpoint("bridge://relay.example.com")).toBe(
      "https://relay.example.com",
    );
    expect(normalizeBridgeEndpoint("bridge://relay.example.com/v1")).toBe(
      "https://relay.example.com/v1",
    );
  });

  test("reads a bare host as https and leaves an explicit scheme alone", () => {
    expect(normalizeBridgeEndpoint("relay.example.com")).toBe("https://relay.example.com");
    expect(normalizeBridgeEndpoint("https://relay.example.com")).toBe("https://relay.example.com");
    expect(normalizeBridgeEndpoint("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  test("the agent factory dials the normalized URL, not the marker", () => {
    // Proof the marker cannot reach the socket: the pair's bridge endpoint is
    // the https URL, so `bridge://` never becomes a protocol Node would dial.
    const pair = createBridgeAgent("bridge://relay.example.com", undefined, LOOPBACK_POLICY);
    expect(pair.bridgeEndpoint?.protocol).toBe("https:");
    expect(pair.bridgeEndpoint?.hostname).toBe("relay.example.com");
  });
});

describe("CONNECT failure classification", () => {  test("a status refusal is a fallback signal and carries the status", () => {
    const refusal = new ProxyConnectRefusalError(405, "Method Not Allowed");
    expect(refusal.statusCode).toBe(405);
    expect(shouldFallbackToBridgeRelay(refusal)).toBe(true);
  });

  test("a handshake error is a fallback signal", () => {
    const handshake = new ProxyConnectHandshakeError(new Error("socket hang up"));
    expect(shouldFallbackToBridgeRelay(handshake)).toBe(true);
  });

  test("an error raised after the tunnel opened is never a fallback signal", () => {
    // A target TLS failure happens inside a tunnel that did open; retrying it
    // through the relay would silently change the transport for a real fault.
    const tlsFailure = Object.assign(new Error("self signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
    expect(shouldFallbackToBridgeRelay(tlsFailure)).toBe(false);
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(shouldFallbackToBridgeRelay(aborted)).toBe(false);
    expect(shouldFallbackToBridgeRelay(new Error("anything else"))).toBe(false);
  });
});
