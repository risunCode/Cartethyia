/**
 * Raw-socket proxy tunneling — for transports that need direct socket
 * control rather than a fetch-shaped call (Cursor's gRPC-Connect-over-HTTP/2
 * session, which drives `http2.connect`'s `createConnection` hook itself).
 * `adapter.ts` covers every fetch-based provider; this covers the one that
 * isn't. Both http/https-CONNECT and SOCKS5 tunnels were verified end-to-end
 * (including TLS + ALPN "h2" negotiation over the tunnel) before wiring in.
 */

import * as http from "node:http";
import * as tls from "node:tls";
import type { Duplex } from "node:stream";
import { SocksClient } from "socks";
import type { ProxyTarget } from "./types";

interface TunnelTarget {
  host: string;
  port: number;
  /** Wrap the tunneled socket in TLS (with ALPN "h2") once connected — the target speaks HTTPS/HTTP2. */
  tls: boolean;
  /** ALPN protocol list for the TLS handshake. Defaults to ["h2"]. */
  alpnProtocols?: string[];
}

function basicAuthHeader(username: string, password: string | null | undefined): string {
  return `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`;
}

/** Opens a raw TCP socket to `target` through an HTTP/HTTPS proxy via CONNECT. */
function connectViaHttpConnect(proxy: ProxyTarget, target: TunnelTarget): Promise<Duplex> {
  const { promise, resolve, reject } = Promise.withResolvers<Duplex>();
  const headers: Record<string, string> = {};
  if (proxy.username) headers["Proxy-Authorization"] = basicAuthHeader(proxy.username, proxy.password);
  const req = http.request({
    host: proxy.host,
    port: proxy.port,
    method: "CONNECT",
    path: `${target.host}:${target.port}`,
    headers,
  });
  req.on("connect", (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      reject(new Error(`Proxy CONNECT to ${target.host}:${target.port} failed: ${res.statusCode}`));
      return;
    }
    resolve(socket);
  });
  req.on("error", reject);
  req.end();
  return promise;
}

/** Opens a raw TCP socket to `target` through a SOCKS5 proxy. */
async function connectViaSocks5(proxy: ProxyTarget, target: TunnelTarget): Promise<Duplex> {
  const { socket } = await SocksClient.createConnection({
    proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username ?? undefined, password: proxy.password ?? undefined },
    command: "connect",
    destination: { host: target.host, port: target.port },
  });
  return socket;
}

/** IP literals can't be used as TLS SNI (`servername`); only set it for real hostnames. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function upgradeToTls(socket: Duplex, target: TunnelTarget): Promise<tls.TLSSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();
  const tlsSocket = tls.connect({
    socket: socket as import("node:net").Socket,
    servername: isIpLiteral(target.host) ? undefined : target.host,
    ALPNProtocols: target.alpnProtocols ?? ["h2"],
  });
  tlsSocket.once("secureConnect", () => resolve(tlsSocket));
  tlsSocket.once("error", reject);
  return promise;
}

/**
 * Establishes a socket tunneled through `proxy` to `target`, TLS-wrapped
 * when `target.tls` is set. Hand the result to `http2.connect(origin, {
 * createConnection: () => socket })` — the socket must already be
 * connecting/connected by the time `createConnection` is invoked, so this
 * is awaited BEFORE calling `http2.connect`, not from inside the callback.
 */
export async function connectThroughProxy(proxy: ProxyTarget, target: TunnelTarget): Promise<Duplex> {
  const rawSocket = proxy.protocol === "socks5" ? await connectViaSocks5(proxy, target) : await connectViaHttpConnect(proxy, target);
  return target.tls ? upgradeToTls(rawSocket, target) : rawSocket;
}
