import type { ModelMetadata, ProxyEndpoint } from "../application/contracts";
import type { ResolvedModelMetadata } from "../application/model-metadata";
import type { ApiKeyPublic } from "../storage";
import { readBoundedJson } from "../open-sse/translate";
import { runtimeMemoryLimits } from "../traffic/limits";
import type { CartethyiaRuntime } from "../bootstrap/composition";
import { errorResponse } from "./shared";

export interface CatalogEntry {
  readonly id: string;
  readonly owned_by: string;
  readonly metadata: ModelMetadata | ResolvedModelMetadata | null;
}

export interface CachedAcl {
  readonly providerAllowlist: readonly string[] | null;
  readonly modelAllowlist: readonly string[] | null;
  readonly modelDenylist: readonly string[] | null;
}

export function requestToken(request: Request): string | null {
  const bearer = request.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) return bearer.slice(7).trim() || null;
  return request.headers.get("x-api-key");
}

function splitAcl(value: string | null): readonly string[] | null {
  if (value === null || value.trim() === "") return null;
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

const aclCache = new WeakMap<ApiKeyPublic, CachedAcl>();

export function aclFor(key: ApiKeyPublic): CachedAcl {
  let cached = aclCache.get(key);
  if (cached === undefined) {
    cached = {
      providerAllowlist: splitAcl(key.providerAllowlist),
      modelAllowlist: splitAcl(key.modelAllowlist),
      modelDenylist: splitAcl(key.modelDenylist),
    };
    aclCache.set(key, cached);
  }
  return cached;
}

export function catalogRevision(runtime: CartethyiaRuntime): number {
  return runtime.routingRevision();
}

export async function buildCatalog(runtime: CartethyiaRuntime): Promise<readonly CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const adapter of runtime.registry.list()) {
    for (const model of adapter.models.list) {
      const id = model.id.startsWith(`${adapter.metadata.id}/`) ? model.id : `${adapter.metadata.id}/${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({ id, owned_by: adapter.metadata.id, metadata: runtime.models.lookup(adapter.metadata.id, model.id) });
    }
  }
  const namedRefs = [
    ...runtime.config.aliases.list().map((alias) => alias.alias),
    ...runtime.config.combos.list().map((combo) => combo.name),
  ];
  const unseen = namedRefs.filter((name) => !seen.has(name));
  const resolved = await Promise.all(unseen.map((name) => runtime.models.resolve(name)));
  for (let i = 0; i < unseen.length; i += 1) {
    const name = unseen[i];
    if (name === undefined) continue;
    const result = resolved[i];
    if (result === undefined || result === null) continue;
    const owner = result.targets[0]?.providerId ?? "alias";
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ id: name, owned_by: owner, metadata: result });
  }

  const mappedRefs = ["claude", "codex", "opencode", "cline", "cursor", "copilot"].flatMap((toolId) => {
    const settings = runtime.config.cliModelMappings.getSettings(toolId);
    if (settings?.enabled !== true) return [];
    return runtime.config.cliModelMappings.list(toolId).filter((mapping) => mapping.enabled);
  });
  const mappedTargets = await Promise.all(mappedRefs.map((mapping) => runtime.models.resolve(mapping.targetModel)));
  for (let i = 0; i < mappedRefs.length; i += 1) {
    const mapping = mappedRefs[i];
    const target = mappedTargets[i];
    if (mapping === undefined || target === undefined || target === null || seen.has(mapping.sourceModel)) continue;
    seen.add(mapping.sourceModel);
    const separator = mapping.sourceModel.indexOf("/");
    entries.push({
      id: mapping.sourceModel,
      owned_by: separator > 0 ? mapping.sourceModel.slice(0, separator) : "mapped",
      metadata: target,
    });
  }
  return entries;
}

class MultipartBodyTooLargeError extends Error {
  constructor() {
    super("multipart body too large");
    this.name = "MultipartBodyTooLargeError";
  }
}

function boundedMultipartRequest(request: Request, maxBytes: number): Request {
  if (request.body === null) throw new Error("multipart request body is missing");
  const reader = request.body.getReader();
  let totalBytes = 0;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          release();
          controller.error(new MultipartBodyTooLargeError());
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!released) void reader.cancel(reason).finally(release);
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    duplex: "half",
  };
  return new Request(request.url, init);
}

async function readImageEditMultipart(request: Request): Promise<unknown | Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > runtimeMemoryLimits.requestBodyBytes) return errorResponse(413, "request_too_large", `Request body exceeds ${runtimeMemoryLimits.requestBodyBytes} bytes`);
  try {
    const boundedRequest = boundedMultipartRequest(request, runtimeMemoryLimits.requestBodyBytes);
    const form = await boundedRequest.formData();
    const model = form.get("model");
    const prompt = form.get("prompt");
    if (typeof model !== "string" || typeof prompt !== "string") return errorResponse(400, "invalid_request", "Image edit form requires model and prompt fields");
    const files = [...form.getAll("image"), ...form.getAll("images")].filter((value) => typeof value !== "string");
    const images: string[] = [];
    for (const value of files) {
      const file = value as unknown as { readonly type?: string; arrayBuffer: () => Promise<ArrayBuffer> };
      const bytes = await file.arrayBuffer();
      images.push(`data:${file.type || "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`);
    }
    return { model, prompt, images };
  } catch (error) {
    if (error instanceof MultipartBodyTooLargeError) return errorResponse(413, "request_too_large", `Request body exceeds ${runtimeMemoryLimits.requestBodyBytes} bytes`);
    return errorResponse(400, "invalid_request", "Image edit body must be valid multipart form data");
  }
}


export async function readProxyBody(request: Request, endpoint: ProxyEndpoint): Promise<unknown | Response> {
  if (endpoint === "/v1/images/edits" && request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) return readImageEditMultipart(request);
  const parsedBody = await readBoundedJson(request, runtimeMemoryLimits.requestBodyBytes);
  if (!parsedBody.ok) {
    if (parsedBody.reason === "too_large") return errorResponse(413, "request_too_large", `Request body exceeds ${runtimeMemoryLimits.requestBodyBytes} bytes`);
    return errorResponse(400, "invalid_request", "Request body must be valid JSON");
  }
  return parsedBody.value;
}
