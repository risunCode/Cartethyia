/**
 * Hosted relay deployment: deploy a small relay worker to Cloudflare Workers,
 * Vercel, or Deno Deploy, then register its URL as an HTTP network pool.
 *
 * Cartethyia already knows how to *use* a hosted relay: a pool whose endpoint
 * host is `*.workers.dev` / `*.vercel.app` / `*.deno.dev` is classified as an
 * application relay and dialed with `x-relay-target` / `x-relay-path` headers
 * (see `network/pool/agent.ts` and `network/outbound-fetch.ts`). This module
 * supplies the other half — the operator does not have to write and deploy the
 * worker by hand.
 *
 * The three providers differ only in their deploy API and their runtime entry
 * shape, so each target contributes a `deploy` function; the worker *source* is
 * one shared template, because the runtime contract (read `x-relay-target`,
 * forward the body, return the upstream response) is identical on all three.
 *
 * Credentials are operator-supplied per deploy and never persisted: they are
 * used for the deploy call and discarded. The resulting relay URL is a public
 * host, which is what the network pool stores.
 */
import { GatewayError } from "../../../transport/gateway-error";

/** A hosted relay target. */
export type RelayTarget = "cloudflare" | "vercel" | "deno";

export const RELAY_TARGETS: readonly RelayTarget[] = ["cloudflare", "vercel", "deno"];

/**
 * The relay worker source, deployed to every target.
 *
 * The contract: `x-relay-target` names the upstream origin and `x-relay-path`
 * the upstream path+query; the worker forwards the request (method, body,
 * headers) to `target + path` and returns the upstream response unchanged. The
 * relay headers and `host` are stripped so the upstream sees a clean request.
 * The same handler body runs on Workers and Vercel Edge (`export default {
 * fetch }`); the Deno entry wraps it in `Deno.serve`.
 */
export const RELAY_WORKER_SOURCE = `// Cartethyia hosted relay.
//
// Forwards a request to the origin named by the x-relay-target header, at the
// path named by x-relay-path. Deployed to Cloudflare Workers / Vercel Edge.
const handler = {
  async fetch(request) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const headers = new Headers(request.headers);
    headers.delete("x-relay-target");
    headers.delete("x-relay-path");
    headers.delete("x-relay-auth");
    headers.delete("host");
    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }
    try {
      const response = await fetch(targetUrl, init);
      return new Response(response.body, { status: response.status, headers: response.headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: String((error && error.message) || error) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
export default handler;
`;

/** A Deno Deploy entry wraps the shared handler in `Deno.serve`. */
export const RELAY_DENO_SOURCE = `${RELAY_WORKER_SOURCE}
Deno.serve((request) => handler.fetch(request));
`;

/** Request to deploy one relay. */
export interface RelayDeployRequest {
  readonly target: RelayTarget;
  /** Provider API token (Cloudflare API token, Vercel token, Deno token). */
  readonly token: string;
  /** Cloudflare account id; required for `cloudflare`, ignored otherwise. */
  readonly accountId?: string;
  /** Project/worker name; a generated name is used when absent. */
  readonly projectName?: string;
}

/** Result of a deploy: the public relay URL, ready to register as a pool. */
export interface RelayDeployResult {
  readonly target: RelayTarget;
  readonly relayUrl: string;
  readonly projectName: string;
}

/** Outbound fetch seam (the validated fetch), so tests can stub deploys. */
export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;

function generateName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      // Cloudflare nests `{ errors: [{ message }] }`; Vercel `{ error: { message } }`.
      const errors = record.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0] as Record<string, unknown>;
        if (typeof first?.message === "string") return first.message;
      }
      const error = record.error;
      if (typeof error === "string") return error;
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
    }
  } catch {
    // Fall through to the raw body.
  }
  return text.slice(0, 240) || `HTTP ${res.status}`;
}

/**
 * Deploys the relay worker to Cloudflare Workers and returns its
 * `*.workers.dev` URL.
 */
async function deployCloudflare(
  fetchImpl: RelayFetch,
  request: RelayDeployRequest,
): Promise<RelayDeployResult> {
  const accountId = request.accountId?.trim();
  if (!accountId) throw new GatewayError("invalid_request", 400, "Cloudflare account id is required");
  const projectName = request.projectName?.trim() || generateName("relay");
  const scriptUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(projectName)}`;
  const form = new FormData();
  form.append(
    "index.js",
    new Blob([RELAY_WORKER_SOURCE], { type: "application/javascript+module" }),
    "index.js",
  );
  form.append(
    "metadata",
    new Blob(
      [JSON.stringify({ main_module: "index.js", compatibility_date: "2024-03-20" })],
      { type: "application/json" },
    ),
    "metadata.json",
  );
  const upload = await fetchImpl(scriptUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${request.token}` },
    body: form,
  });
  if (!upload.ok)
    throw new GatewayError("platform_unavailable", upload.status, `Cloudflare deploy failed: ${await readError(upload)}`);
  // Enable the workers.dev route; a failure here is non-fatal because the
  // subdomain lookup below decides the final URL and reports its own error.
  await fetchImpl(`${scriptUrl}/subdomain`, {
    method: "POST",
    headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  }).catch(() => undefined);
  const subdomainRes = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
    { headers: { authorization: `Bearer ${request.token}` } },
  );
  if (!subdomainRes.ok)
    throw new GatewayError(
      "platform_unavailable",
      subdomainRes.status,
      `Worker uploaded but its workers.dev subdomain could not be read: ${await readError(subdomainRes)}`,
    );
  const subdomainData = (await subdomainRes.json().catch(() => ({}))) as {
    result?: { subdomain?: string };
  };
  const subdomain = subdomainData.result?.subdomain;
  if (!subdomain)
    throw new GatewayError(
      "platform_unavailable",
      502,
      "Worker uploaded but no workers.dev subdomain is configured for this Cloudflare account.",
    );
  return { target: "cloudflare", projectName, relayUrl: `https://${projectName}.${subdomain}.workers.dev` };
}

/** Deploys the relay worker to Vercel and returns its `*.vercel.app` URL. */
async function deployVercel(
  fetchImpl: RelayFetch,
  request: RelayDeployRequest,
): Promise<RelayDeployResult> {
  const projectName = request.projectName?.trim() || generateName("relay");
  const deployRes = await fetchImpl("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: projectName,
      target: "production",
      files: [
        { file: "api/relay.js", data: RELAY_WORKER_SOURCE },
        {
          file: "vercel.json",
          data: JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/api/relay" }] }),
        },
      ],
      projectSettings: { framework: null },
    }),
  });
  if (!deployRes.ok)
    throw new GatewayError("platform_unavailable", deployRes.status, `Vercel deploy failed: ${await readError(deployRes)}`);
  const deployment = (await deployRes.json().catch(() => ({}))) as { url?: string };
  if (!deployment.url)
    throw new GatewayError("platform_unavailable", 502, "Vercel deploy returned no URL");
  return {
    target: "vercel",
    projectName,
    relayUrl: deployment.url.startsWith("http") ? deployment.url : `https://${deployment.url}`,
  };
}

/** Deploys the relay worker to Deno Deploy and returns its `*.deno.dev` URL. */
async function deployDeno(
  fetchImpl: RelayFetch,
  request: RelayDeployRequest,
): Promise<RelayDeployResult> {
  const projectName = request.projectName?.trim() || generateName("relay");
  const deployRes = await fetchImpl("https://dash.deno.com/api/deployments", {
    method: "POST",
    headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
    body: JSON.stringify({ project: projectName, entryPoint: "main.ts", files: { "main.ts": RELAY_DENO_SOURCE } }),
  });
  if (!deployRes.ok)
    throw new GatewayError("platform_unavailable", deployRes.status, `Deno deploy failed: ${await readError(deployRes)}`);
  const deployment = (await deployRes.json().catch(() => ({}))) as { url?: string; domains?: string[] };
  const url = deployment.url ?? deployment.domains?.[0];
  if (!url)
    throw new GatewayError("platform_unavailable", 502, "Deno deploy returned no URL");
  return {
    target: "deno",
    projectName,
    relayUrl: url.startsWith("http") ? url : `https://${url}`,
  };
}

const DEPLOYERS: Record<RelayTarget, (fetchImpl: RelayFetch, request: RelayDeployRequest) => Promise<RelayDeployResult>> = {
  cloudflare: deployCloudflare,
  vercel: deployVercel,
  deno: deployDeno,
};

/** Whether `value` is a supported relay target. */
export function isRelayTarget(value: unknown): value is RelayTarget {
  return typeof value === "string" && (RELAY_TARGETS as readonly string[]).includes(value);
}

/**
 * Deploys a relay to the requested target. `fetchImpl` is the validated
 * outbound fetch (so the deploy call is SSRF-checked like every other egress);
 * tests pass a stub.
 */
export async function deployRelay(
  fetchImpl: RelayFetch,
  request: RelayDeployRequest,
): Promise<RelayDeployResult> {
  if (!request.token.trim())
    throw new GatewayError("invalid_request", 400, `${request.target} API token is required`);
  return DEPLOYERS[request.target](fetchImpl, request);
}
