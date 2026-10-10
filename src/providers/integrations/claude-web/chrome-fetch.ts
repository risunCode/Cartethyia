import { Impit, type HttpMethod } from "impit";

const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);
const client = new Impit({ browser: "chrome136" });

/** Fetch implementation whose TLS fingerprint matches Chrome. */
export function createChromeFetch(): typeof fetch {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();
    const response = await client.fetch(request.url, {
      ...(METHODS.has(method as HttpMethod) ? { method: method as HttpMethod } : {}),
      headers: request.headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
      ...(request.signal.aborted || init?.signal ? { signal: request.signal } : {}),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  return Object.assign(fetchImpl, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
}
