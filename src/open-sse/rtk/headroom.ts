import type { ContentBlock, NormalizedMessage, ProxyRequest } from "../../application/contracts";
import { isRecord } from "../../application/protocols";
import { assertPublicUrlAtDispatch, fetchWithSsrfGuard } from "../../security/ssrf-guard";
const MIN_HEADROOM_TEXT = 500;
const MAX_HEADROOM_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface HeadroomConfig {
  readonly enabled: boolean;
  readonly url: string | null;
  readonly timeoutMs: number;
  readonly compressUserMessages: boolean;
}

export interface HeadroomSummary {
  readonly attempted: boolean;
  readonly compressedBlocks: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly reason: string | null;
}

export interface HeadroomOutcome {
  readonly request: ProxyRequest;
  readonly summary: HeadroomSummary;
}

interface HeadroomTarget {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly text: string;
}

interface HeadroomMessage {
  readonly role: "tool" | "user";
  readonly content: string;
}

function endpointFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/v1/compress`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return 0;
  }
}

function textFromHeadroomMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const content = value.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => typeof part.text === "string" ? part.text : null)
    .filter((text): text is string => text !== null);
  return parts.length > 0 ? parts.join("\n") : null;
}

function buildProjection(messages: readonly NormalizedMessage[], compressUserMessages: boolean): { messages: HeadroomMessage[]; targets: HeadroomTarget[] } {
  const projected: HeadroomMessage[] = [];
  const targets: HeadroomTarget[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message === undefined) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (block === undefined || typeof block.text !== "string" || block.text.length < MIN_HEADROOM_TEXT) continue;
      if (block.type === "tool_result" && block.toolResultIsError !== true) {
        projected.push({ role: "tool", content: block.text });
        targets.push({ messageIndex, blockIndex, text: block.text });
      } else if (compressUserMessages && message.role === "user" && block.type === "text") {
        projected.push({ role: "user", content: block.text });
        targets.push({ messageIndex, blockIndex, text: block.text });
      }
    }
  }
  return { messages: projected, targets };
}

function applyProjection(request: ProxyRequest, compressed: readonly unknown[], targets: readonly HeadroomTarget[]): { request: ProxyRequest; compressedBlocks: number; bytesBefore: number; bytesAfter: number } {
  if (compressed.length !== targets.length) return { request, compressedBlocks: 0, bytesBefore: 0, bytesAfter: 0 };
  const updates = new Map<number, Map<number, string>>();
  let compressedBlocks = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const text = textFromHeadroomMessage(compressed[index]);
    if (!target || text === null || text.length === 0 || text.length >= target.text.length) continue;
    const blockUpdates = updates.get(target.messageIndex) ?? new Map<number, string>();
    blockUpdates.set(target.blockIndex, text);
    updates.set(target.messageIndex, blockUpdates);
    compressedBlocks += 1;
    bytesBefore += target.text.length;
    bytesAfter += text.length;
  }
  if (updates.size === 0) return { request, compressedBlocks: 0, bytesBefore: 0, bytesAfter: 0 };
  const messages = request.messages.map((message, messageIndex) => {
    const blockUpdates = updates.get(messageIndex);
    if (blockUpdates === undefined) return message;
    const content = message.content.map((block, blockIndex) => {
      const text = blockUpdates.get(blockIndex);
      return text === undefined ? block : { ...block, text } satisfies ContentBlock;
    });
    return { ...message, content };
  });
  return { request: { ...request, messages }, compressedBlocks, bytesBefore, bytesAfter };
}

function initialOutcome(request: ProxyRequest, reason: string | null): HeadroomOutcome {
  return {
    request,
    summary: { attempted: false, compressedBlocks: 0, bytesBefore: 0, bytesAfter: 0, reason },
  };
}

/**
 * Compresses large tool results through a Headroom /v1/compress service.
 * Every failure is fail-open: the original normalized request is returned.
 */
export async function compressWithHeadroom(request: ProxyRequest, config: HeadroomConfig): Promise<HeadroomOutcome> {
  if (!config.enabled) return initialOutcome(request, "disabled");
  if (config.url === null) return initialOutcome(request, "missing_url");
  const endpoint = endpointFor(config.url);
  if (endpoint === null) return initialOutcome(request, "invalid_url");
  const allowedProtocols: Readonly<Record<string, true>> = Bun.env.NODE_ENV === "development" || Bun.env.NODE_ENV === "test" ? { "http:": true, "https:": true } : { "https:": true };
  const parsedEndpoint = new URL(endpoint);
  const localTestEndpoint = Bun.env.NODE_ENV === "test" && (parsedEndpoint.hostname === "127.0.0.1" || parsedEndpoint.hostname === "localhost" || parsedEndpoint.hostname === "::1");
  try {
    if (!localTestEndpoint) await assertPublicUrlAtDispatch(endpoint, { label: "Headroom URL", allowedProtocols });
  } catch {
    return initialOutcome(request, "blocked_url");
  }
  const projection = buildProjection(request.messages, config.compressUserMessages);
  if (projection.messages.length === 0) return initialOutcome(request, "no_compressible_messages");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onCallerAbort = (): void => controller.abort();
  request.signal.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const payload: Record<string, unknown> = { messages: projection.messages, model: request.model };
    if (config.compressUserMessages) payload.config = { compress_user_messages: true };
    const requestInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "manual",
    };
    const response = localTestEndpoint
      ? await fetch(endpoint, requestInit)
      : await fetchWithSsrfGuard(endpoint, requestInit, { maxRedirects: 2 });
    if (!response.ok) return initialOutcome(request, `http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_HEADROOM_RESPONSE_BYTES) return initialOutcome(request, "response_too_large");
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_HEADROOM_RESPONSE_BYTES) return initialOutcome(request, "response_too_large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return initialOutcome(request, "invalid_json");
    }
    if (!isRecord(parsed)) return initialOutcome(request, "invalid_response");
    const compressed = parsed.messages;
    if (!Array.isArray(compressed)) return initialOutcome(request, "missing_messages");
    const applied = applyProjection(request, compressed, projection.targets);
    if (applied.compressedBlocks === 0) return initialOutcome(request, "no_shrink");
    return {
      request: applied.request,
      summary: {
        attempted: true,
        compressedBlocks: applied.compressedBlocks,
        bytesBefore: applied.bytesBefore,
        bytesAfter: applied.bytesAfter,
        reason: null,
      },
    };
  } catch (error) {
    return initialOutcome(request, error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onCallerAbort);
  }
}

export function formatHeadroomSummary(summary: HeadroomSummary): string | null {
  if (!summary.attempted || summary.compressedBlocks === 0) return null;
  return `[Headroom] compressed ${summary.compressedBlocks} tool results, ${summary.bytesBefore}B -> ${summary.bytesAfter}B`;
}

export function headroomPayloadBytes(request: ProxyRequest): number {
  return jsonBytes(request.messages);
}
