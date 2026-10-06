/**
 * Capability degradation: ordered request variants for capability-aware routing.
 *
 * When nothing supports the full request, progressively stripped copies are
 * planned in turn — the first variant with a non-empty plan wins without ever
 * consulting a blind pool. Degradation is a last resort and is never silent:
 * the planner warns (throttled here) when a request was dispatched degraded.
 */
import type { CanonicalRequest, ContentPart } from "../../protocol/canonical-model";
import { deriveRequiredCapabilities, type RequiredCapability } from "../translation/capabilities";

// Degradation is often sustained — a client that always asks for tools against
// a tools-less route degrades every single request. An unthrottled warn would
// flood pino and push unrelated lines out of the bounded in-memory console
// ring, so each (model, capability-set) pair logs at most once per minute.
const DEGRADATION_WARN_INTERVAL_MS = 60_000;
const DEGRADATION_WARN_MAX_KEYS = 256;
const lastDegradationWarnAt = new Map<string, number>();

export function shouldWarnDegradation(key: string, now: number): boolean {
  const previous = lastDegradationWarnAt.get(key);
  if (previous !== undefined && now - previous < DEGRADATION_WARN_INTERVAL_MS) return false;
  if (lastDegradationWarnAt.size >= DEGRADATION_WARN_MAX_KEYS) {
    for (const [existingKey, at] of lastDegradationWarnAt)
      if (now - at >= DEGRADATION_WARN_INTERVAL_MS) lastDegradationWarnAt.delete(existingKey);
    // Still full after pruning: a burst of distinct keys, not sustained
    // traffic. Reset rather than grow unbounded; the next warn re-establishes.
    if (lastDegradationWarnAt.size >= DEGRADATION_WARN_MAX_KEYS) lastDegradationWarnAt.clear();
  }
  lastDegradationWarnAt.set(key, now);
  return true;
}

/**
 * Ordered by blast radius: cheapest to degrade first, most semantic (tools/image)
 * last. Generation controls and extensions are stripped before prompt caching,
 * structured output, reasoning, and finally tools/images. This keeps the happy
 * path lossless while guaranteeing a text-only degraded fallback always exists
 * (unless the model itself is unknown).
 */
function degradeRequestForCapability(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  if (capability.startsWith("generation_control:"))
    return degradeGenerationControl(request, capability);
  if (capability.startsWith("extension:")) return degradeExtensionPart(request, capability);
  switch (capability) {
    case "prompt_caching":
      return degradePromptCaching(request);
    case "response_format.json_object":
    case "response_format.json_schema":
      return degradeResponseFormat(request);
    case "reasoning.encrypted_content":
      return degradeEncryptedReasoning(request);
    case "reasoning":
      return degradeReasoning(request);
    case "parallel_tool_calls":
      return degradeParallelToolCalls(request);
    case "tools":
      return degradeTools(request);
    case "image":
    case "document":
    case "audio":
      return degradeMediaPart(request, capability);
    default:
      return null;
  }
}

/** Drops one generation-control key. Passthrough hints, so nothing else moves. */
function degradeGenerationControl(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  const key = capability.slice(
    "generation_control:".length,
  ) as keyof typeof request.generation_controls;
  if (!(key in request.generation_controls)) return null;
  const next = { ...request.generation_controls };
  delete next[key];
  return { ...request, generation_controls: next };
}

/**
 * Strips content parts carrying one named extension.
 *
 * Content-part extension: the `RequiredCapability` namespace. Generation-
 * control keys on `GenerationControls` share the `extension:` prefix but are
 * passthrough hints read by the wire codec; they are not degradable by name and
 * are deliberately left untouched here.
 */
function degradeExtensionPart(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  const name = capability.slice("extension:".length);
  const stripExtensionParts = (parts: readonly ContentPart[]): readonly ContentPart[] =>
    parts.filter((p) => !(p.kind === "extension" && p.name === name));
  const nextMessages = request.messages.map((m) => ({
    ...m,
    content: stripExtensionParts(m.content),
  }));
  const nextSystem = request.system ? stripExtensionParts(request.system) : request.system;
  const nextInstructions = request.instructions
    ? stripExtensionParts(request.instructions)
    : request.instructions;
  const hasExtension = request.messages.some((m) =>
    m.content.some((p) => p.kind === "extension" && p.name === name),
  );
  if (!hasExtension && !nextSystem?.length && !nextInstructions?.length) return null;
  return {
    ...request,
    messages: nextMessages,
    ...(nextSystem !== undefined ? { system: nextSystem } : {}),
    ...(nextInstructions !== undefined ? { instructions: nextInstructions } : {}),
  };
}

function degradePromptCaching(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.cache_hint) return null;
  const { cache_hint: _ch, ...rest } = request;
  return rest;
}

function degradeResponseFormat(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.response_format) return null;
  const { response_format: _rf, ...rest } = request;
  return rest;
}

/** Drops encrypted reasoning from the request and from every carried part. */
export function degradeEncryptedReasoning(request: CanonicalRequest): CanonicalRequest | null {
  if (
    !request.reasoning &&
    !request.messages.some((m) =>
      m.content.some(
        (p) =>
          p.kind === "reasoning" &&
          (p as Extract<ContentPart, { kind: "reasoning" }>).encrypted_content,
      ),
    )
  )
    return null;
  const nextMessages = request.messages.map((m) => ({
    ...m,
    content: m.content.map((p) => {
      if (
        p.kind === "reasoning" &&
        (p as Extract<ContentPart, { kind: "reasoning" }>).encrypted_content
      ) {
        const { encrypted_content: _ec, ...rest } = p as Extract<
          ContentPart,
          { kind: "reasoning" }
        >;
        return rest as ContentPart;
      }
      return p;
    }),
  }));
  return { ...request, messages: nextMessages };
}

function degradeReasoning(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.reasoning) return null;
  const { reasoning: _r, ...rest } = request;
  return rest;
}

function degradeParallelToolCalls(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.generation_controls.parallel_tool_calls) return null;
  return {
    ...request,
    generation_controls: { ...request.generation_controls, parallel_tool_calls: false },
  };
}

/**
 * Drops the tool catalog and rewrites tool traffic in every message to a text
 * placeholder, so the conversation still reads as a transcript of what
 * happened rather than losing the turns entirely.
 */
function degradeTools(request: CanonicalRequest): CanonicalRequest | null {
  if (!request.tools?.length) return null;
  const nextMessages = request.messages.map((m) => {
    const hasToolPart = m.content.some((p) => p.kind === "toolCall" || p.kind === "toolResult");
    if (!hasToolPart) return m;
    const textFallback = m.content
      .filter((p) => p.kind === "toolCall")
      .map((p) => `[tool:${(p as Extract<ContentPart, { kind: "toolCall" }>).name}]`)
      .join("\n");
    const remaining: ContentPart[] = m.content.filter((p) => p.kind === "text") as ContentPart[];
    if (textFallback) remaining.push({ kind: "text", text: textFallback });
    const content: readonly ContentPart[] = remaining.length
      ? remaining
      : [{ kind: "text", text: "[tools removed]" }];
    return { ...m, content };
  });
  const { tools: _t, tool_choice: _tc, ...rest } = request;
  return { ...rest, messages: nextMessages };
}

/**
 * Replaces one attached-media kind with a text placeholder. `document` also
 * covers the `file` part kind, which is the same attachment on a different
 * wire family.
 */
function degradeMediaPart(
  request: CanonicalRequest,
  capability: RequiredCapability,
): CanonicalRequest | null {
  const placeholder =
    capability === "image" ? "[image]" : capability === "document" ? "[document]" : "[audio]";
  const matches = (part: ContentPart): boolean =>
    capability === "document"
      ? part.kind === "document" || part.kind === "file"
      : part.kind === capability;
  const strip = (parts: readonly ContentPart[]): readonly ContentPart[] =>
    parts.flatMap((p): ContentPart[] => (matches(p) ? [{ kind: "text", text: placeholder }] : [p]));
  const hasPart =
    request.messages.some((m) => m.content.some(matches)) ||
    (request.system?.some(matches) ?? false);
  if (!hasPart) return null;
  const nextMessages = request.messages.map((m) => ({ ...m, content: strip(m.content) }));
  if (request.system) {
    return { ...request, messages: nextMessages, system: strip(request.system) };
  }
  return { ...request, messages: nextMessages };
}

/**
 * Ordered request variants for capability-aware routing: the original
 * request first, then progressively degraded copies (same greedy
 * least-impact-first order as before). The planner plans each variant in
 * turn — the router filters candidates per variant, so the first variant
 * with a non-empty plan wins without ever consulting a blind pool.
 *
 * Yields successively degraded request variants lazily. The common case —
 * first variant plans successfully — never builds the remaining clones.
 */
export function* degradedRequestVariants(
  original: CanonicalRequest,
): Generator<{
  request: CanonicalRequest;
  degraded: readonly RequiredCapability[];
  required: readonly RequiredCapability[];
}> {
  const required = deriveRequiredCapabilities(original);
  yield { request: original, degraded: [], required };
  const priority: RequiredCapability[] = [
    ...required.filter((c) => c.startsWith("generation_control:") || c.startsWith("extension:")),
    "prompt_caching",
    "response_format.json_object",
    "response_format.json_schema",
    "reasoning.encrypted_content",
    "reasoning",
    "parallel_tool_calls",
    "tools",
    "image",
    "document",
    "audio",
  ] as RequiredCapability[];
  const ordered = priority.filter((c) => required.includes(c));
  let current: CanonicalRequest = original;
  const degraded: RequiredCapability[] = [];
  for (const cap of ordered) {
    const next = degradeRequestForCapability(current, cap);
    if (!next) continue;
    degraded.push(cap);
    current = next;
    yield {
      request: current,
      degraded: [...degraded],
      required: required.filter((c) => !degraded.includes(c)),
    };
  }
}
