// Web-search detection, invocation extraction, and response evidence.
import type { CanonicalEvent, CanonicalRequest, ToolDefinition } from "../../protocol/canonical-model";

/**
 * Returns whether one declared tool is a *hosted* web-search tool — one the
 * provider executes, not one the client runs itself.
 *
 * Identified by its wire type marker and never by name alone. A coding client
 * ships its own client-side `WebSearch` tool: a plain named tool the CLI
 * executes locally. Matching that by name made the gateway treat it as
 * provider-side, run the fallback bridge, and strip the declaration — so the
 * upstream model genuinely lost its `WebSearch` tool and answered "I don't
 * have a WebSearch tool", while the client's own search loop was disabled
 * for the rest of the session.
 *
 * A hosted declaration always announces itself: Anthropic sends
 * `type: "web_search_20250305"`, an [OI]-compatible wire sends
 * `type: "web_search"` / `web_search_preview`. Both are explicit, and neither
 * is a name.
 */
export function isWebSearchTool(
  tool: Pick<ToolDefinition, "name" | "native_type" | "tool_type">,
): boolean {
  // Anthropic's hosted search tool (`web_search_20250305`, …).
  if (tool.native_type?.startsWith("web_search_") === true) return true;
  // `classifyNativeToolType` maps `web_search` / `web_search_preview` and
  // friends onto this tool_type on every wire.
  return tool.tool_type === "web_search";
}

/**
 * Name-based check for a search *invocation* — a model calling `web_search`
 * by name, which has no type marker to read.
 *
 * Deliberately separate from {@link isWebSearchTool}: declarations decide
 * whether to strip a tool, where acting on a name alone destroys client-side
 */
export function isWebSearchToolName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z]/g, "");
  return (
    normalized === "websearch" ||
    normalized === "websearchpreview" ||
    name.startsWith("web_search")
  );
}


function parseSearchArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parseSearchArguments(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Search query and result-count request extracted from a canonical turn. */
export interface WebSearchInvocation {
  readonly query: string;
  readonly maxResults: number;
}

/** Returns true when a canonical request declares or invokes web search. */
export function requestUsesWebSearch(request: CanonicalRequest): boolean {
  if (request.tools?.some(isWebSearchTool) === true) return true;
  // Function-form declarations (Buddy family: `{type:"function", function:{name:"web_search",…}}`)
  // carry no hosted marker, but a gateway-declared search function is the same
  // capability. Only names that are actually search tools count.
  if (request.tools?.some((tool) => isWebSearchToolName(tool.name)) === true) return true;
  return request.messages.some((message) =>
    message.content.some(
      (part) => part.kind === "toolCall" && isWebSearchToolName(part.name),
    ),
  );
}

/** Extracts a bounded search invocation from tool arguments or the latest user text. */
export function extractWebSearchInvocation(
  request: CanonicalRequest,
): WebSearchInvocation | undefined {
  if (!requestUsesWebSearch(request)) return undefined;
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];
      if (part?.kind !== "toolCall" || !isWebSearchToolName(part.name)) continue;
      const args = parseSearchArguments(part.arguments);
      const rawQuery = typeof args?.query === "string" ? args.query.trim() : "";
      // Model-authored: already the search intent itself, never scaffolding.
      // Pass it through untouched — editing it here can only lose intent.
      const query = rawQuery.length > MAX_SEARCH_QUERY_CHARS ? rawQuery.slice(0, MAX_SEARCH_QUERY_CHARS) : rawQuery;
      if (query.length === 0) continue;
      const rawMax = args?.max_results;
      const maxResults =
        typeof rawMax === "number" && Number.isFinite(rawMax)
          ? Math.min(Math.max(1, Math.floor(rawMax)), 50)
          : 10;
      return { query, maxResults };
    }
  }
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = request.messages[messageIndex];
    if (message?.role !== "user") continue;
    const query = sanitizeSearchQuery(
      message.content
        .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
        .map((part) => part.text)
        .join("\n"),
    );
    if (query.length > 0) return { query, maxResults: 10 };
  }
  return undefined;
}

/** Upper bound on a derived search query; real queries are far shorter. */
const MAX_SEARCH_QUERY_CHARS = 512;

/**
 * Trims a user turn down to the operator's own words for use as a query.
 *
 * Deliberately does **not** rewrite the text. Rewriting a turn is how you
 * lose the question: a blanket tag-strip would mangle a legitimate query
 * about `<div>`, an XML config, or a markdown snippet, and a coding client's
 * injected scaffolding is not the only XML a user ever types.
 *
 * Instead it cuts at the first injected block opener. A coding client
 * (Claude Code) *appends* its `<system-reminder>` — CLAUDE.md, agent
 * definitions, tool docs — to the end of the turn, so the operator's own
 * sentence is always the prefix and survives intact. Everything from the
 * opener on is dropped without being read or edited.
 *
 * What this fixes: sending the whole turn verbatim made the provider match
 * on the injected prose and return pages *about those files*. A request for
 * "risuncode" came back with CLAUDE.md, CodeGraph, and AGENTS.md pages.
 *
 * The result is a query only — it never reaches the model, and the model
 * still receives the full, unmodified conversation.
 */
export function sanitizeSearchQuery(text: string): string {
  let end = text.length;
  for (const tag of INJECTED_QUERY_OPENERS) {
    const match = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(text);
    if (match && match.index < end) end = match.index;
  }
  const head = text.slice(0, end).replace(/\s+/g, " ").trim();
  if (head.length <= MAX_SEARCH_QUERY_CHARS) return head;
  // Cut on a word boundary; a mid-word slice searches a fragment.
  const sliced = head.slice(0, MAX_SEARCH_QUERY_CHARS);
  const lastSpace = sliced.lastIndexOf(" ");
  return (lastSpace > MAX_SEARCH_QUERY_CHARS / 2 ? sliced.slice(0, lastSpace) : sliced).trim();
}

/**
 * Tags a client wraps its own injected context in. Only their *openers*
 * matter — matching the opener alone is what keeps this from editing any
 * user-typed content that happens to look like markup.
 */
const INJECTED_QUERY_OPENERS = [
  "system-reminder",
  "system-reminders",
  "system_instruction",
  "local-command-stdout",
  "command-name",
  "command-message",
  "command-args",
  "session-start-hook",
] as const;

/**
 * True when a completed response actually carries web-search evidence.
 *
 * A route marked `search_route: "native"` is trusted to run the hosted search
 * itself, but "trusted" is only a capability declaration: the upstream may
 * answer from its own weights without ever calling the tool — which a client
 * sees as a confident answer with no sources, or (worse) as "Did 0 searches".
 * This checks what the response actually contains rather than what the route
 * claimed: an Anthropic `server_tool_use`/`web_search_tool_result` round, a
 * `search_result` block, a search citation extension, or an inline URL.
 *
 * Ported from oh-my-pi's grounding rejection, which refuses a Codex/OpenAI
 * completion with no `web_search_call` rather than presenting it as searched.
 */
export function responseShowsWebSearch(events: readonly CanonicalEvent[]): boolean {
  for (const event of events) {
    if (event.type !== "content_delta") continue;
    const part = event.content;
    if (part.kind === "extension") {
      if (SEARCH_EVIDENCE_EXTENSIONS.has(part.name)) return true;
      continue;
    }
    if (part.kind !== "text") continue;
    // A model that really searched cites where it got the answer. Markdown
    // links and bare URLs both count; a prose answer with no source at all
    // is what we are trying to detect and reject.
    if (/https?:\/\/\S+/i.test(part.text)) return true;
  }
  return false;
}

/** Extension parts that only a provider-side search round can produce. */
const SEARCH_EVIDENCE_EXTENSIONS = new Set([
  "server_tool_use",
  "search_result",
  "web_search_tool_result",
  "web_search_citations",
]);
