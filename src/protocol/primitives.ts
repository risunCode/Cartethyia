/**
 * Shared wire-protocol primitives used by every provider codec in
 * `src/protocol/`. This is the single home for the generic guards, UTF-16
 * well-formedness coercion, JSON/argument helpers, hash helpers, endpoint
 * URL construction, image-source resolution, and custom-header validation
 * that the per-wire request/response codecs build on — previously duplicated
 * across the Claude/Codex protocol modules and `providers/compatible-adapter`.
 *
 * Provider-specific primitives that depend on provider identity (e.g. Codex
 * identity headers) deliberately live with their provider, not here.
 */
import { providerBaseUrl } from "../providers/provider-metadata";
import { GatewayError } from "../transport/gateway-error";
import type { CanonicalStopReason, CanonicalTerminalEvent, UsageRecord } from "../transport/canonical-model";
import { type WireFamily } from "../transport/canonical-model";
import type { GenerationControls } from "../transport/canonical-model";
import { BASE_PROTECTED_HEADERS, HEADER_CONTROL, HEADER_TOKEN } from "../security/outbound-headers";
import { unwrapProviderToken } from "../providers/credential-envelope";

const TEXT_ENCODER = new TextEncoder();
/**
 * Shared 32-bit string hash (`hash * 31` accumulation, unsigned).
 */
export function hash32(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export const CLAUDE_TOOL_PREFIX = "_";

export type ClaudeWireObject = Record<string, unknown>;

/**
 * Object (non-array) narrowing for untyped wire JSON.
 *
 * The single record guard for the codebase. It lives here, in the lowest layer
 * that needs it, because `transport/surface` already imports from this module:
 * having protocol import a guard from surface created a cycle across layers.
 */
export function isRecord(value: unknown): value is ClaudeWireObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const stringValue = (value: unknown): value is string =>
  typeof value === "string";
export const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Wire guards: generic record/field readers used by protocol codecs. */
export function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

/**
 * Reads an SSE frame's `output_index` as an integer slot.
 *
 * The Responses/Codex wires address output items by a fractional-capable
 * JSON number. Callers key maps and route deltas on this value, so a
 * non-integer index must be truncated rather than rejected: a fractional
 * index still identifies the same slot. Non-finite values (`NaN`,
 * `Infinity`) are discarded so they never become a map key, and a missing or
 * non-numeric field yields `undefined` rather than `0` so an absent index
 * cannot collide with a real slot zero.
 */
export function readOutputIndex(record: Record<string, unknown>): number | undefined {
  const candidate = record["output_index"];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.trunc(candidate)
    : undefined;
}

export function readBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

// Tool-call ID normalization

const ANTHROPIC_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function hashId(input: string): string {
  return hash32(input).toString(16).padStart(8, "0");
}

function isValidAnthropicToolCallId(id: string): boolean {
  return ANTHROPIC_ID_RE.test(id);
}

function fallbackAnthropicToolCallId(original: string): string {
  return `toolu_${hashId(original)}`;
}

/** Appends `_dupN`, carving the suffix out of the 64-char budget. */
function withDuplicateSuffix(canonical: string, index: number): string {
  const suffix = `_dup${index}`;
  return `${canonical.slice(0, 64 - suffix.length)}${suffix}`;
}

/**
 * Normalizes a tool-call ID for Anthropic's strict 64-char `^[a-zA-Z0-9_-]+$` requirement.
 * - Handles OpenAI Responses composite `callId|itemId` by taking the first segment.
 * - Replaces invalid chars with `_`, truncates to 64, and falls back to `toolu_<hash>` if empty.
 *
 * `seen` is the per-request uniqueness ledger: one map for a whole request, passed
 * in so every id in that request is distinct. It counts how many times each id has
 * been emitted (or reserved as a base), and this function is its only writer.
 *
 * The ledger is keyed on the CANONICAL form — the value after replacement,
 * truncation, and the hash fallback — not on the raw id. Keying on the raw was the
 * bug: two raws that canonicalize to the same base (`call!x` and `call@x` both
 * become `call_x`) have to share one counter, or the second one re-derives a
 * suffix the first already handed out. Both ends of the ledger are therefore
 * reserved: the base, and any generated `_dupN` result, so a later id that
 * naturally equals a generated one does not collide with it.
 */
export function normalizeAnthropicToolCallId(
  raw: string,
  seen: Map<string, number> = new Map(),
): string {
  // Handle composite IDs from Responses API: `call_id|item_id`
  const base = raw.includes("|") ? (raw.split("|")[0] ?? raw) : raw;
  let canonical = base.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (canonical.length === 0) canonical = fallbackAnthropicToolCallId(raw);
  if (canonical.length > 64) {
    // Keep prefix + hash suffix to avoid collisions
    const hash = hashId(raw);
    canonical = `${canonical.slice(0, 55)}_${hash.slice(0, 8)}`.slice(0, 64);
  }
  if (!isValidAnthropicToolCallId(canonical)) {
    canonical = fallbackAnthropicToolCallId(raw);
  }
  // Walk forward from this base's next free index until an id nobody holds is
  // found. The first candidate is the canonical form itself, which is free
  // exactly when the base has never been emitted.
  let index = seen.get(canonical) ?? 0;
  let normalized = index === 0 ? canonical : withDuplicateSuffix(canonical, index);
  while (seen.has(normalized)) {
    index += 1;
    normalized = withDuplicateSuffix(canonical, index);
  }
  // Reserve both ends: the base so the next call starts past this index, and the
  // generated id so a later raw that canonicalizes to it is forced to a new one.
  seen.set(canonical, index + 1);
  if (normalized !== canonical) seen.set(normalized, (seen.get(normalized) ?? 0) + 1);
  return normalized;
}

// Anthropic tool-schema sanitization

const SUPPORTED_SCHEMA_KEYS: Readonly<Record<string, true>> = Object.freeze({
  $ref: true,
  $defs: true,
  definitions: true,
  type: true,
  enum: true,
  const: true,
  description: true,
  title: true,
  default: true,
  properties: true,
  required: true,
  additionalProperties: true,
  items: true,
  anyOf: true,
  oneOf: true,
  allOf: true,
  minItems: true,
  maxItems: true,
  minLength: true,
  maxLength: true,
  pattern: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  minProperties: true,
  maxProperties: true,
});

export function sanitizeSchemaForAnthropic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchemaForAnthropic);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // Property names are user-defined schema keys, not JSON-Schema keywords;
    // preserve them while sanitizing each property's schema recursively.
    if (key === "properties" && isRecord(child)) {
      out.properties = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, sanitizeSchemaForAnthropic(schema)]),
      );
      continue;
    }
    // Drop wire-unsupported keywords so a strict upstream never 400s on
    // them — but never invent caller text to say so. The dropped names are
    // debug-logged by the caller-facing builder when that matters.
    if (!SUPPORTED_SCHEMA_KEYS[key]) continue;
    out[key] = sanitizeSchemaForAnthropic(child);
  }
  const properties = out.properties;
  if (isRecord(properties)) {
    out.type ??= "object";
    // A-Carte's Anthropic-compatible endpoint validates tool schemas as
    // strict objects: every declared property must also appear in required.
    // Rebuild from the sanitized property names so dropped/unknown entries
    // cannot leave an invalid required list behind.
    out.required = Object.keys(properties);
  }
  return out;
}

// OAuth tool-name prefixing

const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "code_execution",
  "code_execution_20250825",
  "code_execution_20260120",
  "code_execution_20260521",
  "text_editor",
  "computer",
  "tool_search_tool_regex_20251119",
  "tool_search_tool_bm25_20251119",
  "tool_search_tool_regex",
  "tool_search_tool_bm25",
  "mcp_toolset",
]);

export function prefixClaudeToolName(name: string, isOAuth: boolean): string {
  if (!isOAuth || ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;
  return `${CLAUDE_TOOL_PREFIX}${name}`;
}

export function unprefixClaudeToolName(name: string, isOAuth: boolean): string {
  if (!isOAuth || !name.startsWith(CLAUDE_TOOL_PREFIX)) return name;
  return name.slice(CLAUDE_TOOL_PREFIX.length);
}

/** Prefix marking an echoed billing attestation block in replayed history. */
export const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

/**
 * Whether a system text block is an echoed billing attestation from a prior
 * turn. Such blocks must never be forwarded upstream again: they attest a
 * different body, and replaying them is precisely what abuse detection keys
 * on. Builders drop them when projecting system content.
 */
export function isClaudeBillingHeaderText(text: string): boolean {
  return text.startsWith(CLAUDE_BILLING_HEADER_PREFIX);
}

// Well-formed UTF-16 coercion

export function toWellFormedString(value: string): string {
  const maybe = value as unknown as { toWellFormed?: () => string };
  if (typeof maybe.toWellFormed === "function") return maybe.toWellFormed();
  // Fallback for runtimes without String.prototype.toWellFormed (replace lone surrogates)
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

export function toWellFormedDeep(value: unknown): unknown {
  if (typeof value === "string") return toWellFormedString(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const sanitized = toWellFormedDeep(entry);
      if (sanitized !== entry) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = toWellFormedDeep(v);
      if (sanitized !== v) changed = true;
      out[k] = sanitized;
    }
    return changed ? out : value;
  }
  return value;
}

// Argument-string JSON coercion

export function parseArguments(value: unknown): unknown {
  // A zero-arg tool call carries "" (or absent) arguments. Callers on the
  // Messages wire need an object (`input`), so an empty string coerces to {}
  // rather than passing "" through and drawing an upstream 400.
  if (typeof value === "string") {
    if (value.trim().length === 0) return {};
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value ?? {};
}

// Endpoint URL construction

export function endpointUrl(
  baseUrl: string | undefined,
  endpointPath: string,
  isOAuth = false,
): string {
  if (/^https?:\/\//i.test(endpointPath)) {
    if (isOAuth && !endpointPath.includes("?beta=true")) {
      const separator = endpointPath.includes("?") ? "&" : "?";
      return `${endpointPath}${separator}beta=true`;
    }
    return endpointPath;
  }
  const url = joinUrl((baseUrl ?? providerBaseUrl("claude")).replace(/\/+$/, ""), endpointPath);
  if (isOAuth) return `${url}?beta=true`;
  return url;
}

/** Session-scoped state (turn-state / models-etag / session identity). */
export interface CodexSessionState {
  sessionId: string;
  threadId: string;
  windowId: string;
  turnState?: string;
  modelsEtag?: string;
  turnStartedAtUnixMs?: number;
}

/**
 * ASCII-safe JSON: escapes every non-ASCII code unit as `\uXXXX`. The
 * `x-codex-turn-metadata` header must stay ASCII-clean and = ~100 KB;
 * mirrors provider `toAsciiJsonString` (openai-codex-responses.ts:623-628).
 */
export function toAsciiJsonString(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(
    /[\x7f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function hashToBase36(input: string): string {
  return hash32(input).toString(36);
}

/**
 * Encodes a tool-call ID as a Responses-safe composite `callId__itemId`.
 * Codex rejects punctuation such as `|` in `id`/`call_id`, so the separator
 * must stay within the upstream `[A-Za-z0-9_-]` contract.
 */
export function encodeCodexToolCallId(
  callId: string,
  itemId?: string | null,
): string {
  const stableItemId =
    itemId !== undefined && itemId !== null && itemId.length > 0
      ? itemId
      : `fc_${hashToBase36(callId)}`;
  return `${callId}__${stableItemId}`;
}

/** Decodes current `__` composites and accepts legacy `|` values on replay. */
export function decodeCodexToolCallId(raw: string): string {
  const separator = raw.includes("__") ? "__" : "|";
  const idx = raw.indexOf(separator);
  return idx === -1 ? raw : raw.slice(0, idx);
}

const CODEX_WIRE_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexWireEffort = (typeof CODEX_WIRE_EFFORT_VALUES)[number];

/**
 * Maps canonical `ReasoningIntent.effort` to the wire tier strings the
 * ChatGPT backend accepts. Identity for the exact canonical vocabulary; an
 * unknown value falls back to `"medium"` rather than dropping the request.
 */
export function mapReasoningEffortToWireTier(
  effort: string | undefined,
): CodexWireEffort | undefined {
  if (effort === undefined) return undefined;
  if ((CODEX_WIRE_EFFORT_VALUES as readonly string[]).includes(effort))
    return effort as CodexWireEffort;
  return "medium";
}

/**
 * Resolves the requested output verbosity from a canonical request's
 * generation controls, independent of the surface it arrived on.
 *
 * Each surface files the same caller intent under a different key: Chat and
 * Completion carry the documented top-level `verbosity` as
 * `extension:verbosity`, Responses nests it under `text.verbosity` and stores
 * it as `extension:responses.verbosity`, and `GenerationControls.verbosity` is
 * the canonical slot. Reading only the canonical slot silently drops the
 * control on every real request, because no surface parser writes it — the
 * caller's `verbosity: "high"` reached the upstream as the model's default.
 *
 * The precedence mirrors `resolvePromptCacheKey`: the surface-specific
 * spelling wins over the bare one, and both win over the canonical slot.
 */
export function resolveOutputVerbosity(
  controls: GenerationControls | undefined,
): string | undefined {
  if (controls === undefined) return undefined;
  const candidates = [
    controls["extension:responses.verbosity"],
    controls["extension:verbosity"],
    controls.verbosity,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Reserved Harmony dialect control-token spellings. Escaping these to the
 * inert backslash form lets untrusted data (user text, tool results,
 * replayed history) reach Harmony-dialect models (gpt-5.x family) without
 * the backend's prompt validator rejecting the whole request as
 * `invalid_prompt` / "Request blocked".
 */
const HARMONY_CONTROL_TOKEN_ESCAPE_RE =
  /<\|(start|end|message|channel|constrain|return|call)\|>/g;

/**
 * Escapes reserved Harmony control tokens. Idempotent — no-op on text
 * without a reserved spelling — so it is safe to apply unconditionally.
 */
export function escapeHarmonyControlTokens(text: string): string {
  return text.replace(HARMONY_CONTROL_TOKEN_ESCAPE_RE, "<\\|$1\\|>");
}

/** Recursively escapes every string leaf of a JSON-like value. */
export function escapeHarmonyControlTokensDeep(value: unknown): unknown {
  if (typeof value === "string") return escapeHarmonyControlTokens(value);
  if (Array.isArray(value))
    return value.map((v) => escapeHarmonyControlTokensDeep(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = escapeHarmonyControlTokensDeep(v);
    }
    return out;
  }
  return value;
}

export function tryParseJsonObject(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Marks every declared property of a tool schema as `required`.
 *
 * OpenAI-compatible bridges reject a tool whose `properties` are not all listed
 * in `required`, so both the OpenCode and buddy-family adapters complete the
 * schema before sending. Property *names* are preserved verbatim (they are
 * caller-defined) while each subschema recurses.
 */
/**
 * Builds the canonical terminal event.
 *
 * Eight call sites across the four response decoders assembled this envelope by
 * hand with the same conditional-spread idiom. Owning it here keeps one field
 * set and one omission rule: an absent optional is omitted, never emitted as an
 * explicit `undefined`.
 */
export function canonicalTerminal(input: {
  readonly sequenceNumber: number;
  readonly state: CanonicalTerminalEvent["state"];
  readonly stopReason?: CanonicalStopReason | undefined;
  readonly providerStopReason?: string | undefined;
  readonly stopDetails?: Record<string, unknown> | undefined;
  readonly usage?: UsageRecord | undefined;
  readonly responseId?: string | undefined;
  readonly eventId?: string | undefined;
}): CanonicalTerminalEvent {
  return {
    type: "terminal",
    sequence_number: input.sequenceNumber,
    state: input.state,
    ...(input.responseId === undefined ? {} : { response_id: input.responseId }),
    ...(input.eventId === undefined ? {} : { event_id: input.eventId }),
    ...(input.stopReason === undefined ? {} : { stop_reason: input.stopReason }),
    ...(input.providerStopReason === undefined
      ? {}
      : { provider_stop_reason: input.providerStopReason }),
    ...(input.stopDetails === undefined ? {} : { stop_details: input.stopDetails }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  };
}

export function completeRequiredSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(completeRequiredSchema);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "properties" && isRecord(child)) {
      out.properties = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, completeRequiredSchema(schema)]),
      );
      continue;
    }
    out[key] = completeRequiredSchema(child);
  }
  if (isRecord(out.properties)) out.required = Object.keys(out.properties);
  return out;
}

export type AuthHeaderShape = "authorization_bearer" | "x_api_key";

/**
 * Fallback endpoint paths for builtin providers on versioned bases.
 * Used only when an adapter omits `endpoint_paths_by_wire_family` and the
 * candidate carries no `endpoint_path` override.
 */
export const BUILTIN_DEFAULT_ENDPOINTS: Record<WireFamily, string> = {
  chat: "/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

/**
 * Endpoint paths for bare-host roots (operator-provided BYOK roots and the
 * generic API-key providers). A bare host has no version segment, so these
 * paths carry their own `/v1` prefix — unlike `BUILTIN_DEFAULT_ENDPOINTS`,
 * whose `chat` value assumes a base that already ends in `/v1`.
 *
 * Pinned explicitly rather than derived: these are wire bytes an operator's
 * upstream expects, so they must not shift when the builtin default changes.
 */
export const BARE_ROOT_ENDPOINTS: Partial<Record<WireFamily, string>> = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

/** An image part's provider-neutral source, resolved from any supported origin shape. */
export interface ResolvedImageSource {
  /** URL or `data:` URI. Mutually usable with `fileId`. */
  url?: string;
  /** Files API reference (Chat/Responses `file_id`). */
  fileId?: string;
  /** OpenAI `detail` hint (`auto`/`low`/`high`), when the origin carried one. */
  detail?: string;
}

/** An RFC 2397 base64 `data:` URL split into the media type and bytes it carries. */
export interface DataUrlPayload {
  /** The declared media type (the `image/png` of `data:image/png;base64,…`). */
  readonly mediaType: string;
  /** The base64 payload, with the `data:` prefix and media type removed. */
  readonly data: string;
}

/**
 * Splits a base64 `data:` URL into its media type and payload.
 *
 * Returns `undefined` for a non-`data:` URL, and for a `data:` URL that is not
 * base64-encoded: every wire this gateway speaks carries inline bytes as
 * base64, so a percent-encoded payload has no transport to land in and the
 * caller must fall back rather than forward bytes it cannot decode.
 *
 * This is the single home for the split. A codec that hand-rolls the regex
 * instead tends to keep the whole `data:` string as a URI, which the upstream
 * then cannot fetch — the attachment is lost while the request still succeeds.
 */
export function splitDataUrl(url: string): DataUrlPayload | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  const mediaType = match?.[1];
  const data = match?.[2];
  if (mediaType === undefined || data === undefined || data.length === 0) return undefined;
  return { mediaType, data };
}

/**
 * Resolves an opaque canonical `image` content part into its URL/file-id/detail
 * triple, tolerating every origin shape this codebase produces:
 * - a bare URL / `data:` URI string (an OpenAI Responses `input_image` payload
 *   is a string, and a tolerant Chat parser keeps a string `image_url` as-is)
 * - OpenAI Chat `{image_url: {url, detail?}}` / `{url, detail?}`
 * - OpenAI Responses `{type:"input_image", image_url, detail?, file_id?}`
 * - Anthropic `{type:"image", source:{type:"base64"|"url"|"file", ...}}`
 *
 * Returns `undefined` only for a shape this gateway cannot re-encode, so
 * callers can degrade explicitly instead of silently dropping the image.
 */
export function resolveImageSource(payload: unknown): ResolvedImageSource | undefined {
  // A bare string is already the URL the wire wants. Accepting it here — rather
  // than in each builder — is what keeps a string-payload image from being
  // dropped on every surface at once.
  if (typeof payload === "string") {
    return payload.length > 0 ? { url: payload } : undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  const topDetail = typeof value["detail"] === "string" ? value["detail"] : undefined;
  // A Responses `input_image` may reference the Files API with a top-level
  // `file_id` and no `image_url` at all; check it before the `image_url` arms,
  // which would otherwise fall through to the generic `url`/`file_id` scan and
  // lose a payload that carries only the id.
  const topFileId = typeof value["file_id"] === "string" ? value["file_id"] : undefined;
  const nested = value["image_url"];
  if (nested === undefined && topFileId !== undefined) {
    return { fileId: topFileId, ...(topDetail === undefined ? {} : { detail: topDetail }) };
  }
  if (typeof nested === "string") {
    return { url: nested, ...(topDetail === undefined ? {} : { detail: topDetail }) };
  }
  if (nested !== null && typeof nested === "object") {
    const inner = nested as Record<string, unknown>;
    const url = typeof inner["url"] === "string" ? inner["url"] : undefined;
    const fileId = typeof inner["file_id"] === "string" ? inner["file_id"] : undefined;
    const detail = typeof inner["detail"] === "string" ? inner["detail"] : topDetail;
    if (url !== undefined || fileId !== undefined) {
      return {
        ...(url === undefined ? {} : { url }),
        ...(fileId === undefined ? {} : { fileId }),
        ...(detail === undefined ? {} : { detail }),
      };
    }
  }
  const url = typeof value["url"] === "string" ? value["url"] : undefined;
  const fileId = typeof value["file_id"] === "string" ? value["file_id"] : undefined;
  if (url !== undefined || fileId !== undefined) {
    return {
      ...(url === undefined ? {} : { url }),
      ...(fileId === undefined ? {} : { fileId }),
      ...(topDetail === undefined ? {} : { detail: topDetail }),
    };
  }
  const source = value["source"];
  if (source !== null && typeof source === "object") {
    const s = source as Record<string, unknown>;
    if (s["type"] === "base64" && typeof s["data"] === "string") {
      const mediaType = typeof s["media_type"] === "string" ? s["media_type"] : "image/png";
      return {
        url: `data:${mediaType};base64,${s["data"]}`,
        ...(topDetail === undefined ? {} : { detail: topDetail }),
      };
    }
    if (s["type"] === "url" && typeof s["url"] === "string") {
      return { url: s["url"], ...(topDetail === undefined ? {} : { detail: topDetail }) };
    }
    if (s["type"] === "file" && typeof s["file_id"] === "string") {
      return { fileId: s["file_id"], ...(topDetail === undefined ? {} : { detail: topDetail }) };
    }
  }
  return undefined;
}

export function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

/**
 * Strips a single leading Bearer envelope (case-insensitive) so adapters
 * never emit `Bearer Bearer`. Delegates to `unwrapProviderToken`
 * (registry.ts), the single token-envelope implementation.
 */
export function normalizeBearerToken(raw: string): string {
  return new TextDecoder().decode(unwrapProviderToken(raw, "bearer"));
}

/**
 * Validates operator-configured outbound custom headers. Protected credential,
 * transport, proxy-identity, and gateway identity names can never be overridden.
 *
 * Single home for custom-header validation (RFC-token name check, 4KiB value
 * cap, control-character check, protected-name rejection).
 *
 * @param extraAllowed additional header names reserved by the calling provider
 * family beyond the base protected list — operator-supplied values for these
 * names are rejected exactly like base protected names. Despite the name,
 * these are extra non-overridable names: "allowed" refers to the family stack
 * itself, which remains allowed to set them (e.g. Claude's stainless
 * SDK-identity and client-identity headers managed by `buildClaudeHeaders`).
 */
export function filterProviderCustomHeaders(
  input: Readonly<Record<string, unknown>> | undefined,
  extraAllowed?: readonly string[],
): Record<string, string> {
  if (!input) return {};
  const extraReserved = new Set((extraAllowed ?? []).map((name) => name.toLowerCase()));
  const filtered: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (!HEADER_TOKEN.test(name)) {
      throw new GatewayError("invalid_request", 400, `invalid custom header name: ${rawName}`, {
        header: rawName,
      });
    }
    if (
      BASE_PROTECTED_HEADERS[name] ||
      extraReserved.has(name) ||
      name.startsWith("x-forwarded-")
    ) {
      throw new GatewayError("invalid_request", 400, `custom header is protected: ${rawName}`, {
        header: rawName,
      });
    }
    if (typeof rawValue !== "string") {
      throw new GatewayError(
        "invalid_request",
        400,
        `custom header value must be a string: ${rawName}`,
        { header: rawName },
      );
    }
    if (TEXT_ENCODER.encode(rawValue).byteLength > 4096) {
      throw new GatewayError(
        "invalid_request",
        400,
        `custom header value exceeds 4KiB: ${rawName}`,
        { header: rawName },
      );
    }
    if (HEADER_CONTROL.test(rawValue)) {
      throw new GatewayError(
        "invalid_request",
        400,
        `custom header value contains control characters: ${rawName}`,
        { header: rawName },
      );
    }
    filtered[name] = rawValue;
  }
  return filtered;
}
