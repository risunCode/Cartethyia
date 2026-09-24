import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import https from "node:https";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { Http2PinnedFetcher, Http2UnsupportedError } from "../../src/network/http2-fetch";

/**
 * Test-only self-signed certificate for 127.0.0.1 (SAN IP:127.0.0.1). It is
 * deliberately not a secret and is used solely to exercise the pinned TLS
 * HTTP/2 client against a local server.
 */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBRzCB7qADAgECAhQHAJxUWOfqLu8lfbl/hFuVTmbSJTAKBggqhkjOPQQDAjAU
MRIwEAYDVQQDDAkxMjcuMC4wLjEwHhcNMjYwOTEyMTYxMDQ0WhcNMzYwOTA5MTYx
MDQ0WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjOPQMB
BwNCAAQ4qRbYAvH1qv15EV3+1NWvXIqQKUMRay6yToQqrZAXPeQhy2oaK7SGEvpg
+I9fAdKhWYuKucwH4hlCgoRowN+2ox4wHDAJBgNVHRMEAjAAMA8GA1UdEQQIMAaH
BH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgDsjytGr7BmFFo4IhDDODgDBRkC7P1oyJ
QSNogfHhlx0CIQCOV14g2Ng4cm83TG188QMtSSEdY2GszxLWb7aRvB0ATg==
-----END CERTIFICATE-----`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgS5zjIvZSzqkSr0kT
gfQq8sdeXspyQQsXg7/z1TOiMVChRANCAAQ4qRbYAvH1qv15EV3+1NWvXIqQKUMR
ay6yToQqrZAXPeQhy2oaK7SGEvpg+I9fAdKhWYuKucwH4hlCgoRowN+2
-----END PRIVATE KEY-----`;

const openServers: Array<{ close: (cb: () => void) => void }> = [];
const openFetchers: Http2PinnedFetcher[] = [];

afterEach(async () => {
  for (const fetcher of openFetchers.splice(0)) fetcher.close();
  await Promise.all(
    openServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

/** Injected factory: real TLS to loopback, trusting the embedded test cert. */
function loopbackTls(params: { port: number }): tls.TLSSocket {
  return tls.connect({
    host: "127.0.0.1",
    port: params.port,
    ca: TEST_CERT,
    // The test cert's SAN is the literal IP, which is what we dial.
    servername: undefined,
    ALPNProtocols: ["h2"],
  });
}

function startH2Server(): Promise<number> {
  return new Promise((resolve) => {
    const server = http2.createSecureServer({ key: TEST_KEY, cert: TEST_CERT });
    server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      if (headers[":path"] === "/echo") {
        stream.respond({
          ":status": 200,
          "content-type": "text/plain",
          "set-cookie": "session=secret",
        });
        stream.end("hello-http2");
        return;
      }
      stream.respond({ ":status": 404 });
      stream.end();
    });
    openServers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function startHttp1OnlyServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("http1");
    });
    openServers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function makeFetcher(): Http2PinnedFetcher {
  const fetcher = new Http2PinnedFetcher({
    createConnection: ({ port }) => loopbackTls({ port }),
  });
  openFetchers.push(fetcher);
  return fetcher;
}

describe("Http2PinnedFetcher", () => {
  test("performs a request and strips credential/hop-by-hop response headers", async () => {
    const port = await startH2Server();
    const fetcher = makeFetcher();
    const response = await fetcher.fetch(
      new URL(`https://127.0.0.1:${port}/echo`),
      { method: "GET" },
      "127.0.0.1",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello-http2");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  test("reuses a multiplexed session for the same origin", async () => {
    const port = await startH2Server();
    const fetcher = makeFetcher();
    const url = new URL(`https://127.0.0.1:${port}/echo`);
    await (await fetcher.fetch(url, { method: "GET" }, "127.0.0.1")).text();
    expect(fetcher.size()).toBe(1);
    await (await fetcher.fetch(url, { method: "GET" }, "127.0.0.1")).text();
    expect(fetcher.size()).toBe(1);
  });

  test("close() drops cached sessions", async () => {
    const port = await startH2Server();
    const fetcher = makeFetcher();
    await (
      await fetcher.fetch(new URL(`https://127.0.0.1:${port}/echo`), { method: "GET" }, "127.0.0.1")
    ).text();
    expect(fetcher.size()).toBe(1);
    fetcher.close();
    expect(fetcher.size()).toBe(0);
  });

  test("reports Http2UnsupportedError when the peer does not negotiate h2", async () => {
    const port = await startHttp1OnlyServer();
    const fetcher = makeFetcher();
    await expect(
      fetcher.fetch(new URL(`https://127.0.0.1:${port}/`), { method: "GET" }, "127.0.0.1"),
    ).rejects.toBeInstanceOf(Http2UnsupportedError);
  });
});
