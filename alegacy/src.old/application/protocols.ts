import { sanitizeMessage, type ApplicationErrorKind } from "./contracts";
import type { ImageReference, NormalizedMessage, ProxyRequest, NormalizedTool, RequestLimits, Surface } from "./contracts";

/**
 * Typed, sanitized failure returned by protocol validation and normalization.
 *
 * Structurally compatible with the application `ProviderCallError` (same required
 * members, narrower literals for `retryable`/`routeScope`), so it composes
 * directly into typed pipeline failures without a second mapping. Validation
 * failures are never retryable and never rotate accounts or proxies.
 */
export interface ProtocolError {
  readonly kind: ApplicationErrorKind;
  readonly statusCode: number;
  readonly sanitizedMessage: string;
  readonly retryable: false;
  readonly routeScope: null;
  readonly retryAt: null;
  /** Dot-separated path of the offending field, e.g. "messages[2].content". */
  readonly field: string;
}

export function applicationError(
  kind: ApplicationErrorKind,
  statusCode: number,
  field: string,
  message: string,
): ProtocolError {
  return {
    kind,
    statusCode,
    sanitizedMessage: sanitizeMessage(message),
    retryable: false,
    routeScope: null,
    retryAt: null,
    field,
  };
}

/** Default invalid-request failure (HTTP 400, never retryable). */
export function protocolError(field: string, message: string): ProtocolError {
  return applicationError("invalid_request", 400, field, message);
}

export function isProtocolError(value: unknown): value is ProtocolError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { field?: unknown; retryable?: unknown; sanitizedMessage?: unknown };
  return candidate.field !== undefined && candidate.retryable === false && candidate.sanitizedMessage !== undefined;
}

/**
 * Bounds applied to every external value during strict normalization.
 * Unknown values are narrowed into these limits or rejected with a typed
 * ProtocolError; nothing from the wire is trusted unbounded.
 */
export const MAX_MODEL_LENGTH = 256;
export const MAX_MESSAGE_COUNT = 2_048;
export const MAX_BLOCKS_PER_MESSAGE = 256;
export const MAX_TEXT_BLOCK_LENGTH = 512_000;
export const MAX_TOOL_COUNT = 128;
export const MAX_TOOL_NAME_LENGTH = 256;
// Claude Code's built-in tools can carry long operational descriptions.
export const MAX_TOOL_DESCRIPTION_LENGTH = 65_536;
export const MAX_TOOL_SCHEMA_LENGTH = 65_536;
export const MAX_TOOL_CALLS_PER_MESSAGE = 64;
export const MAX_TOOL_ARGUMENT_LENGTH = 512_000;
export const MAX_IMAGE_COUNT = 64;
export const MAX_IMAGE_URL_LENGTH = 4_096;
export const MAX_DATA_URL_LENGTH = 8 * 1024 * 1024;
export const MAX_MEDIA_TYPE_LENGTH = 128;
export const MAX_OUTPUT_TOKENS = 2_000_000;

/** True for plain objects (never arrays), the only wire values we read fields from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a plain object or null — used to extract optional object wire fields without erroring. */
export function narrowRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Returns a finite number or null — used to extract optional numeric wire fields. */
export function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Concatenates text blocks of a normalized message, joined by newline. */
export function messageText(message: NormalizedMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

/** Normalizes the optional `stream` flag: absent/null is false; otherwise boolean. */
export function normalizeStream(raw: unknown): boolean | ProtocolError {
  if (raw === undefined || raw === null) return false;
  return narrowBoolean(raw, "stream");
}

export function narrowObject(value: unknown, field: string): Record<string, unknown> | ProtocolError {
  if (!isRecord(value)) return protocolError(field, `${field}: expected an object`);
  return value;
}

export function narrowString(value: unknown, field: string, maxLength: number): string | ProtocolError {
  if (typeof value !== "string") return protocolError(field, `${field}: expected a string`);
  if (value.length > maxLength) return protocolError(field, `${field}: exceeds maximum length of ${maxLength} characters`);
  return value;
}

export function narrowBoolean(value: unknown, field: string): boolean | ProtocolError {
  if (typeof value !== "boolean") return protocolError(field, `${field}: expected a boolean`);
  return value;
}

export interface NumberOptions {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export function narrowNumber(value: unknown, field: string, options: NumberOptions = {}): number | ProtocolError {
  if (typeof value !== "number" || !Number.isFinite(value)) return protocolError(field, `${field}: expected a finite number`);
  if (options.integer === true && !Number.isInteger(value)) return protocolError(field, `${field}: expected an integer`);
  if (options.min !== undefined && value < options.min) return protocolError(field, `${field}: must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) return protocolError(field, `${field}: must be at most ${options.max}`);
  return value;
}

export function narrowArray(value: unknown, field: string, maxLength: number): unknown[] | ProtocolError {
  if (!Array.isArray(value)) return protocolError(field, `${field}: expected an array`);
  if (value.length > maxLength) return protocolError(field, `${field}: exceeds maximum length of ${maxLength} items`);
  return value;
}
export function narrowMessageArray(value: unknown, field: string, maxLength: number): unknown[] | ProtocolError {
  if (!Array.isArray(value)) return protocolError(field, `${field}: expected an array`);
  if (value.length > maxLength) {
    return protocolError(
      field,
      `${field}: exceeds maximum length of ${maxLength} items (received ${value.length}). Please use /compact to reduce conversation history, then retry.`,
    );
  }
  return value;
}

/**
 * Bounds the serialized size of a nested value (tool schemas) without
 * copying it. Parsed JSON cannot be circular, so this never throws in
 * practice; the catch is defensive only.
 */
export function boundJsonLength(value: unknown, field: string, maxLength: number): ProtocolError | null {
  let length = 0;
  try {
    length = JSON.stringify(value)?.length ?? 0;
  } catch {
    return protocolError(field, `${field}: could not be serialized`);
  }
  if (length > maxLength) return protocolError(field, `${field}: exceeds ${maxLength} characters when serialized`);
  return null;
}

/** Returns a finite string or null — used to extract optional string wire fields without erroring. */
export function narrowText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Returns the value as an array, or an empty array when it is not one. */
export function narrowList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Coerces a wire value into a plain object: objects pass through, JSON
 * strings are parsed, and anything else falls back to an empty object. Used
 * by cross-protocol response translation for tool-call arguments.
 */
export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Options controlling how a codec's raw tool list is normalized. */
export interface NormalizeToolListOptions {
  /** When true, the tool body is wrapped under a `function` field (OpenAI Chat). */
  readonly unwrapFunction: boolean;
  /** Wire field holding the JSON schema (`parameters` or `input_schema`). */
  readonly schemaField: string;
  /** When true, the schema is required and a missing/non-object value errors. */
  readonly schemaRequired: boolean;
}

/**
 * Shared tool-list normalization for every chat/responses/anthropic codec.
 *
 * The three codecs differ only in tool wrapper shape (`function` unwrap vs
 * direct), the schema field name (`parameters` vs `input_schema`), and whether
 * the schema is required. Claude's server-side tools are preserved as bounded
 * native metadata; target adapters decide whether they can forward or
 * explicitly adapt them.
 */
const ANTHROPIC_WEB_SEARCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query." },
    allowed_domains: { type: "array", items: { type: "string" } },
    blocked_domains: { type: "array", items: { type: "string" } },
  },
  required: ["query"],
  additionalProperties: false,
};

const ANTHROPIC_WEB_FETCH_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch." },
    allowed_domains: { type: "array", items: { type: "string" } },
    blocked_domains: { type: "array", items: { type: "string" } },
  },
  required: ["url"],
  additionalProperties: false,
};

const ANTHROPIC_NATIVE_TOOL_TYPES: Record<string, string> = {
  web_search_20250305: "web_search_20250305",
  web_search_20260209: "web_search_20260209",
  web_search_20260318: "web_search_20260318",
  web_fetch_20250910: "web_fetch_20250910",
  web_fetch_20260209: "web_fetch_20260209",
  web_fetch_20260318: "web_fetch_20260318",
  code_execution_20250825: "code_execution_20250825",
  code_execution_20260120: "code_execution_20260120",
  code_execution_20260521: "code_execution_20260521",
  tool_search_tool_regex_20251119: "tool_search_tool_regex_20251119",
  tool_search_tool_bm25_20251119: "tool_search_tool_bm25_20251119",
  tool_search_tool_regex: "tool_search_tool_regex",
  tool_search_tool_bm25: "tool_search_tool_bm25",
  mcp_toolset: "mcp_toolset",
};

const ANTHROPIC_NATIVE_TOOL_NAMES: Record<string, string> = {
  web_search_20250305: "web_search",
  web_search_20260209: "web_search",
  web_search_20260318: "web_search",
  web_fetch_20250910: "web_fetch",
  web_fetch_20260209: "web_fetch",
  web_fetch_20260318: "web_fetch",
  code_execution_20250825: "code_execution",
  code_execution_20260120: "code_execution",
  code_execution_20260521: "code_execution",
  tool_search_tool_regex_20251119: "tool_search_tool_regex",
  tool_search_tool_bm25_20251119: "tool_search_tool_bm25",
  tool_search_tool_regex: "tool_search_tool_regex",
  tool_search_tool_bm25: "tool_search_tool_bm25",
  mcp_toolset: "mcp_toolset",
};

function isAnthropicWebToolType(value: string | undefined): boolean {
  return value?.startsWith("web_search_") === true || value?.startsWith("web_fetch_") === true;
}

export function normalizeToolList(raw: unknown, options: NormalizeToolListOptions): NormalizedTool[] | ProtocolError {
  if (raw === undefined || raw === null) return [];
  const list = narrowArray(raw, "tools", MAX_TOOL_COUNT);
  if (isProtocolError(list)) return list;
  const tools: NormalizedTool[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const field = `tools[${i}]`;
    if (item === undefined) continue;
    const obj = narrowObject(item, field);
    if (isProtocolError(obj)) return obj;
    const type = typeof obj["type"] === "string" ? obj["type"] : undefined;
    // Native tool types are intentionally open-ended. Known types receive
    // semantic defaults; unknown types remain opaque for same-surface
    // passthrough and are still available to cross-protocol adapters.
    const nativeType = type !== undefined && type !== "function" ? type : undefined;
    const isKnownNative = nativeType !== undefined && ANTHROPIC_NATIVE_TOOL_TYPES[nativeType] !== undefined;
    const isNativeWebTool = isAnthropicWebToolType(nativeType);
    const source = options.unwrapFunction && nativeType === undefined
      ? narrowObject(obj["function"], `${field}.function`)
      : obj;
    if (isProtocolError(source)) return source;
    const nameField = options.unwrapFunction ? `${field}.function.name` : `${field}.name`;
    const rawName = source["name"] ?? (nativeType === undefined ? undefined : ANTHROPIC_NATIVE_TOOL_NAMES[nativeType] ?? nativeType);
    const name = narrowString(rawName, nameField, MAX_TOOL_NAME_LENGTH);
    if (isProtocolError(name)) return name;
    if (name.trim() === "") return protocolError(nameField, "tool name must not be empty");
    let description: string | null = null;
    const descriptionRaw = source["description"];
    if (descriptionRaw !== undefined && descriptionRaw !== null) {
      const descriptionField = options.unwrapFunction ? `${field}.function.description` : `${field}.description`;
      const descriptionValue = narrowString(descriptionRaw, descriptionField, MAX_TOOL_DESCRIPTION_LENGTH);
      if (isProtocolError(descriptionValue)) return descriptionValue;
      description = descriptionValue;
    }
    let inputSchema: Record<string, unknown>;
    let nativeOptions: Readonly<Record<string, unknown>> | undefined;
    if (nativeType !== undefined) {
      if (isKnownNative && name !== ANTHROPIC_NATIVE_TOOL_NAMES[nativeType] && nativeType !== "mcp_toolset") {
        return protocolError(nameField, `unsupported Anthropic server tool name "${name}"`);
      }
      if (nativeType.startsWith("web_search_")) inputSchema = ANTHROPIC_WEB_SEARCH_SCHEMA;
      else if (nativeType.startsWith("web_fetch_")) inputSchema = ANTHROPIC_WEB_FETCH_SCHEMA;
      else inputSchema = {};
      const optionsObject = { ...obj };
      delete optionsObject.type;
      delete optionsObject.name;
      if (isNativeWebTool) {
        const maxUses = obj["max_uses"];
        if (maxUses !== undefined && (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100)) {
          return protocolError(`${field}.max_uses`, `${field}.max_uses: expected an integer from 1 to 100`);
        }
      }
      const nativeOptionsError = boundJsonLength(optionsObject, field, MAX_TEXT_BLOCK_LENGTH);
      if (nativeOptionsError !== null) return nativeOptionsError;
      nativeOptions = optionsObject;
    } else {
      const schemaFieldPath = options.unwrapFunction ? `${field}.function.${options.schemaField}` : `${field}.${options.schemaField}`;
      const schemaRaw = source[options.schemaField];
      if (schemaRaw === undefined || schemaRaw === null) {
        if (options.schemaRequired) return protocolError(schemaFieldPath, `${schemaFieldPath}: expected an object`);
        inputSchema = {};
      } else {
        const schema = narrowObject(schemaRaw, schemaFieldPath);
        if (isProtocolError(schema)) return schema;
        inputSchema = schema;
      }
    }
    let schemaJsonLength = 0;
    try {
      schemaJsonLength = JSON.stringify(inputSchema)?.length ?? 0;
    } catch {
      return protocolError(`${field}.${options.schemaField}`, `${field}.${options.schemaField}: could not be serialized`);
    }
    if (schemaJsonLength > MAX_TOOL_SCHEMA_LENGTH) {
      return protocolError(`${field}.${options.schemaField}`, `${field}.${options.schemaField}: exceeds ${MAX_TOOL_SCHEMA_LENGTH} characters when serialized`);
    }
    let deferLoading: boolean | undefined;
    if (source["defer_loading"] !== undefined) {
      const value = narrowBoolean(source["defer_loading"], `${field}.defer_loading`);
      if (isProtocolError(value)) return value;
      deferLoading = value;
    }
    let allowedCallers: readonly string[] | undefined;
    if (source["allowed_callers"] !== undefined) {
      const values = narrowArray(source["allowed_callers"], `${field}.allowed_callers`, MAX_TOOL_COUNT);
      if (isProtocolError(values)) return values;
      const normalized: string[] = [];
      for (let j = 0; j < values.length; j++) {
        const value = narrowString(values[j], `${field}.allowed_callers[${j}]`, MAX_TOOL_NAME_LENGTH);
        if (isProtocolError(value)) return value;
        normalized.push(value);
      }
      allowedCallers = normalized;
    }
    let inputExamples: readonly Record<string, unknown>[] | undefined;
    if (source["input_examples"] !== undefined) {
      const values = narrowArray(source["input_examples"], `${field}.input_examples`, 10);
      if (isProtocolError(values)) return values;
      const normalized: Record<string, unknown>[] = [];
      for (let j = 0; j < values.length; j++) {
        const value = narrowObject(values[j], `${field}.input_examples[${j}]`);
        if (isProtocolError(value)) return value;
        normalized.push(value);
      }
      inputExamples = normalized;
    }
    tools.push({
      name,
      description,
      inputSchema,
      ...(nativeType !== undefined ? { nativeType, nativeOptions } : {}),
      raw: obj,
      schemaJsonLength,
      ...(deferLoading !== undefined ? { deferLoading } : {}),
      ...(allowedCallers !== undefined ? { allowedCallers } : {}),
      ...(inputExamples !== undefined ? { inputExamples } : {}),
    });
  }
  return tools;
}


/**
 * SSRF-safe image reference classification.
 *
 * Normalization never fetches image payloads; it only classifies the
 * reference syntactically so a later fetch (image decode/re-encode) can run
 * without ever touching private, loopback, or reserved targets:
 *
 * - `data:` URLs are bounded inline payloads and always safe.
 * - `http(s)` URLs must be absolute, credential-free, and resolve to a
 *   public address: no IP literals in private/loopback/link-local/reserved
 *   ranges (IPv4 and IPv6, including IPv4-mapped/NAT64/4-in-6 encodings),
 *   no localhost/private-use names, no ambiguous single-label hosts.
 * - Anything else is rejected with a typed ProtocolError.
 */
export type ImageClassification =
  | { readonly ok: true; readonly reference: ImageReference }
  | { readonly ok: false; readonly error: ProtocolError };

export function classifyImageReference(value: unknown, field: string): ImageClassification {
  if (typeof value !== "string") return fail(field, `${field}: expected a string reference`);
  const trimmed = value.trim();
  if (trimmed === "") return fail(field, `${field}: image reference must not be empty`);
  if (/^data:/i.test(trimmed)) return classifyDataUrl(trimmed, field);
  return classifyHttpUrl(trimmed, field);
}

/** Appends a classified reference, enforcing the global image-count bound. */
export function pushImageReference(target: ImageReference[], reference: ImageReference, field: string): ProtocolError | null {
  if (target.length >= MAX_IMAGE_COUNT) return protocolError(field, `${field}: exceeds maximum of ${MAX_IMAGE_COUNT} images`);
  target.push(reference);
  return null;
}

function fail(field: string, message: string): ImageClassification {
  return { ok: false, error: protocolError(field, message) };
}

function classifyDataUrl(value: string, field: string): ImageClassification {
  if (value.length > MAX_DATA_URL_LENGTH) return fail(field, `${field}: inline image exceeds ${MAX_DATA_URL_LENGTH} characters`);
  const comma = value.indexOf(",");
  if (comma < 0) return fail(field, `${field}: malformed data URL (missing ",")`);
  const meta = value.slice("data:".length, comma);
  const mediaType = parseMediaType(meta, field);
  if (isProtocolError(mediaType)) return { ok: false, error: mediaType };
  return { ok: true, reference: { kind: "data", value, mediaType } };
}

function parseMediaType(meta: string, field: string): string | null | ProtocolError {
  const first = meta.split(";")[0];
  if (first === undefined || first === "") return null;
  const mediaType = first.toLowerCase();
  if (mediaType.length > MAX_MEDIA_TYPE_LENGTH) return protocolError(field, `${field}: media type exceeds ${MAX_MEDIA_TYPE_LENGTH} characters`);
  return mediaType;
}

function classifyHttpUrl(value: string, field: string): ImageClassification {
  if (value.length > MAX_IMAGE_URL_LENGTH) return fail(field, `${field}: URL exceeds ${MAX_IMAGE_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(field, `${field}: malformed URL`);
  }
  const scheme = url.protocol;
  if (scheme !== "http:" && scheme !== "https:") return fail(field, `${field}: unsupported URL scheme "${scheme.slice(0, -1) || "?"}"`);
  if (url.username !== "" || url.password !== "") return fail(field, `${field}: URLs with embedded credentials are not allowed`);
  const hostname = normalizeHostname(url.hostname);
  if (hostname === null) return fail(field, `${field}: URL has no usable host`);
  if (isPrivateUseName(hostname)) return fail(field, `${field}: URL host is a loopback or private-use name`);
  if (isIpLiteral(hostname)) {
    if (isUnsafeIp(hostname)) return fail(field, `${field}: URL host is a private, loopback, or reserved address`);
  } else if (!hostname.includes(".")) {
    return fail(field, `${field}: URL host must be a fully qualified domain name`);
  }
  return { ok: true, reference: { kind: "url", value, mediaType: null } };
}

export function normalizeHostname(host: string): string | null {
  let value = host.toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  value = value.replace(/\.$/, "");
  return value === "" ? null : value;
}

export function isPrivateUseName(host: string): boolean {
  if (host === "localhost") return true;
  for (const suffix of [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan"]) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}

export function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || (host.includes(":") && ipv6ToBigInt(host) !== null);
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (Number(part) > 255) return false;
  }
  return true;
}

export function isUnsafeIp(host: string): boolean {
  if (isIpv4Literal(host)) return isUnsafeIpv4(ipv4ToUint32(host));
  const value = ipv6ToBigInt(host);
  if (value === null) return true;
  return isUnsafeIpv6(value);
}

function ipv4ToUint32(host: string): number {
  const parts = host.split(".");
  return ((Number(parts[0]) * 256 + Number(parts[1])) * 256 + Number(parts[2])) * 256 + Number(parts[3]);
}

function isUnsafeIpv4(value: number): boolean {
  return (
    value < 0x01000000 || // 0.0.0.0/8
    (value >= 0x0a000000 && value < 0x0b000000) || // 10.0.0.0/8
    (value >= 0x64400000 && value < 0x64800000) || // 100.64.0.0/10 (CGNAT)
    (value >= 0x7f000000 && value < 0x80000000) || // 127.0.0.0/8 (loopback)
    (value >= 0xa9fe0000 && value < 0xa9ff0000) || // 169.254.0.0/16 (link-local)
    (value >= 0xac100000 && value < 0xac200000) || // 172.16.0.0/12
    (value >= 0xc0000000 && value < 0xc0000100) || // 192.0.0.0/24
    (value >= 0xc0000200 && value < 0xc0000300) || // 192.0.2.0/24 (TEST-NET-1)
    (value >= 0xc0a80000 && value < 0xc0a90000) || // 192.168.0.0/16
    (value >= 0xc6120000 && value < 0xc6140000) || // 198.18.0.0/15 (benchmarking)
    (value >= 0xc6336400 && value < 0xc6336500) || // 198.51.100.0/24 (TEST-NET-2)
    (value >= 0xcb007100 && value < 0xcb007200) || // 203.0.113.0/24 (TEST-NET-3)
    value >= 0xe0000000 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  );
}

interface BigIntRange {
  readonly lo: bigint;
  readonly hi: bigint;
}

function ipv6Range(prefixHex: string, prefixBits: number): BigIntRange {
  const prefix = BigInt(`0x${prefixHex}`);
  const freeBits = 128n - BigInt(prefixBits);
  const mask = (1n << 128n) - (1n << freeBits);
  const lo = prefix & mask;
  return { lo, hi: lo | ((1n << freeBits) - 1n) };
}

const UNSAFE_IPV6_RANGES: readonly BigIntRange[] = [
  ipv6Range("00000000000000000000000000000000", 128), // ::
  ipv6Range("00000000000000000000000000000001", 128), // ::1
  ipv6Range("00000000000000000000000000000000", 96), // ::/96 (IPv4-compatible)
  ipv6Range("00000000000000000000ffff00000000", 96), // ::ffff:0:0/96 (IPv4-mapped)
  ipv6Range("0064ff9b000000000000000000000000", 96), // 64:ff9b::/96 (NAT64)
  ipv6Range("0064ff9b000100000000000000000000", 48), // 64:ff9b:1::/48 (NAT64 local-use)
  ipv6Range("fc000000000000000000000000000000", 7), // fc00::/7 (unique-local)
  ipv6Range("fe800000000000000000000000000000", 10), // fe80::/10 (link-local)
  ipv6Range("ff000000000000000000000000000000", 8), // ff00::/8 (multicast)
  ipv6Range("20010db8000000000000000000000000", 32), // 2001:db8::/32 (documentation)
  ipv6Range("20010010000000000000000000000000", 28), // 2001:10::/28 (ORCHID)
  ipv6Range("20010002000000000000000000000000", 48), // 2001:2::/48 (benchmarking)
  ipv6Range("01000000000000000000000000000000", 64), // 100::/64 (discard-only)
];

function isUnsafeIpv6(value: bigint): boolean {
  for (const range of UNSAFE_IPV6_RANGES) {
    if (value >= range.lo && value <= range.hi) return true;
  }
  const embedded = embeddedIpv4(value);
  if (embedded !== null && isUnsafeIpv4(embedded)) return true;
  return false;
}

function embeddedIpv4(value: bigint): number | null {
  if (value < 0x100000000n) return Number(value); // ::/96
  const upper = value >> 32n;
  if (upper === 0xffffn) return Number(value & 0xffffffffn); // ::ffff:0:0/96
  if (upper === 0x64ff9bn) return Number(value & 0xffffffffn); // 64:ff9b::/96
  return null;
}

function parseHextet(part: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
  return Number.parseInt(part, 16);
}

function ipv4ToHextets(part: string): readonly [number, number] | null {
  const octets = part.split(".");
  if (octets.length !== 4) return null;
  const nums: number[] = [];
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const value = Number(octet);
    if (value > 255) return null;
    nums.push(value);
  }
  return [(nums[0] ?? 0) * 256 + (nums[1] ?? 0), (nums[2] ?? 0) * 256 + (nums[3] ?? 0)];
}

function ipv6ToBigInt(host: string): bigint | null {
  if (!host.includes(":")) return null;
  const compressed = host.split("::");
  if (compressed.length > 2) return null;
  let left: string[] = compressed[0] === "" ? [] : (compressed[0] ?? "").split(":");
  let right: string[] = compressed.length === 2 ? (compressed[1] === "" ? [] : (compressed[1] ?? "").split(":")) : [];
  let v4: readonly [number, number] | null = null;
  const lastLeft = left[left.length - 1];
  if (lastLeft !== undefined && lastLeft.includes(".")) {
    v4 = ipv4ToHextets(lastLeft);
    if (v4 === null) return null;
    left = left.slice(0, -1);
  } else {
    const lastRight = right[right.length - 1];
    if (lastRight !== undefined && lastRight.includes(".")) {
      v4 = ipv4ToHextets(lastRight);
      if (v4 === null) return null;
      right = right.slice(0, -1);
    }
  }
  const groups: number[] = [];
  for (const part of left) {
    const hextet = parseHextet(part);
    if (hextet === null) return null;
    groups.push(hextet);
  }
  if (compressed.length === 2) {
    const missing = 8 - groups.length - right.length - (v4 === null ? 0 : 2);
    if (missing < 0) return null;
    for (let i = 0; i < missing; i++) groups.push(0);
  }
  for (const part of right) {
    const hextet = parseHextet(part);
    if (hextet === null) return null;
    groups.push(hextet);
  }
  if (v4 !== null) groups.push(v4[0], v4[1]);
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | BigInt(group);
  }
  return value;
}

/** Pipeline-provided context every normalizer needs beyond the wire body. */
export interface NormalizeInput {
  readonly signal: AbortSignal;
  readonly limits: RequestLimits;
}

/**
 * Validate/normalize outcome: either a fully narrowed
 * `NormalizedProviderRequest` or a typed, sanitized failure.
 */
export type NormalizeResult =
  | { readonly ok: true; readonly request: ProxyRequest }
  | { readonly ok: false; readonly error: ProtocolError };

export function normalizeOk(request: ProxyRequest): NormalizeResult {
  return { ok: true, request };
}

export function normalizeFail(error: ProtocolError): NormalizeResult {
  return { ok: false, error };
}

/** Entry check so an already-aborted request never reaches deep normalization. */
export function abortedError(signal: AbortSignal): ProtocolError | null {
  if (!signal.aborted) return null;
  return applicationError("client_aborted", 499, "request", "request was aborted before normalization completed");
}

