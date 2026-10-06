import type {
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  ContentPart,
  ToolDefinition,
} from "../../../protocol/canonical-model";

/**
 * MiMo Studio's bot-chat endpoint takes one `query` string and has no tool
 * protocol: the `tools` field is ignored upstream, and the answer comes back
 * as plain text. Tool use therefore has to be carried in the prompt.
 *
 * MiMo models answer a tool instruction in their own trained convention —
 * `<tool_call><function=NAME><parameter=KEY>VALUE</parameter></function></tool_call>`
 * — and accept results back as `<tool_result>`. Teaching the model a different
 * format does not work: asked for a JSON block it still emits this one. So the
 * gateway adopts the model's convention instead of fighting it.
 */

/** A tool call recovered from model text. */
export interface MimoStudioToolCall {
  name: string;
  /** JSON object string, matching the canonical `tool_call_delta` contract. */
  arguments: string;
}

const CALL_OPEN = "<tool_call>";
const CALL_CLOSE = "</tool_call>";
const FUNCTION_OPEN = "<function=";
const FUNCTION_CLOSE = "</function>";
const PARAMETER_OPEN = "<parameter=";
const PARAMETER_CLOSE = "</parameter>";
const RESULT_OPEN = "<tool_result>";
const RESULT_CLOSE = "</tool_result>";

/** Bound on a held-back block so a malformed stream cannot buffer unbounded. */
const MAX_BLOCK_CHARS = 64 * 1024;

function parameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"' && first !== "t" && first !== "f" && first !== "n") {
    return raw;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/**
 * Parses one `<function=…>` body. Returns undefined for a block that does not
 * name a function, so the caller can release it as prose rather than invent a
 * call the model never made.
 */
function parseFunctionBody(body: string): MimoStudioToolCall | undefined {
  const nameEnd = body.indexOf(">");
  if (nameEnd === -1) return undefined;
  const name = body.slice(0, nameEnd).trim();
  if (name.length === 0) return undefined;
  const argumentsRecord: Record<string, unknown> = {};
  const rest = body.slice(nameEnd + 1);
  let cursor = 0;
  while (true) {
    const openAt = rest.indexOf(PARAMETER_OPEN, cursor);
    if (openAt === -1) break;
    const keyEnd = rest.indexOf(">", openAt + PARAMETER_OPEN.length);
    if (keyEnd === -1) break;
    const key = rest.slice(openAt + PARAMETER_OPEN.length, keyEnd).trim();
    const closeAt = rest.indexOf(PARAMETER_CLOSE, keyEnd + 1);
    if (closeAt === -1) break;
    argumentsRecord[key] = parameterValue(rest.slice(keyEnd + 1, closeAt));
    cursor = closeAt + PARAMETER_CLOSE.length;
  }
  return { name, arguments: JSON.stringify(argumentsRecord) };
}

/**
 * Parses one complete `<tool_call>` block, which may hold several
 * `<function=…>` entries emitted back to back.
 */
export function parseMimoStudioToolCallBlock(block: string): MimoStudioToolCall[] {
  const calls: MimoStudioToolCall[] = [];
  let cursor = 0;
  while (true) {
    const openAt = block.indexOf(FUNCTION_OPEN, cursor);
    if (openAt === -1) break;
    const closeAt = block.indexOf(FUNCTION_CLOSE, openAt + FUNCTION_OPEN.length);
    if (closeAt === -1) break;
    const parsed = parseFunctionBody(block.slice(openAt + FUNCTION_OPEN.length, closeAt));
    if (parsed !== undefined) calls.push(parsed);
    cursor = closeAt + FUNCTION_CLOSE.length;
  }
  return calls;
}

/**
 * Streaming-safe extractor for the MiMo tool convention.
 *
 * Feed answer text through {@link push} in order; released text never contains
 * a complete or partial block, so the client sees clean prose while each closed
 * block surfaces through `calls`. {@link flush} restores an unterminated
 * remainder as plain text — a block the model never closed is chatter, never an
 * invented call.
 */
export class MimoStudioToolExtractor {
  #pending = "";
  #state: "text" | "call" = "text";
  #block = "";
  #callCount = 0;

  push(chunk: string): { text: string; calls: MimoStudioToolCall[] } {
    let buffer = this.#pending + chunk;
    this.#pending = "";
    let text = "";
    const calls: MimoStudioToolCall[] = [];
    let cursor = 0;
    for (;;) {
      if (this.#state === "text") {
        const openAt = buffer.indexOf("<", cursor);
        if (openAt === -1) {
          text += buffer.slice(cursor);
          break;
        }
        text += buffer.slice(cursor, openAt);
        cursor = openAt;
        const rest = buffer.slice(cursor);
        if (rest.startsWith(CALL_OPEN)) {
          cursor += CALL_OPEN.length;
          this.#state = "call";
          this.#block = "";
          continue;
        }
        if (CALL_OPEN.startsWith(rest)) {
          // A partial `<tool_call` could still become a block; hold it back.
          this.#pending = rest;
          break;
        }
        text += "<";
        cursor += 1;
        continue;
      }
      const combined = this.#block + buffer.slice(cursor);
      const closeAt = combined.indexOf(CALL_CLOSE);
      if (closeAt === -1) {
        if (combined.length > MAX_BLOCK_CHARS) {
          text += `${CALL_OPEN}${combined}`;
          this.#block = "";
          this.#state = "text";
        } else {
          this.#block = combined;
        }
        break;
      }
      const inner = combined.slice(0, closeAt);
      cursor += closeAt + CALL_CLOSE.length - this.#block.length;
      this.#block = "";
      this.#state = "text";
      const parsed = parseMimoStudioToolCallBlock(inner);
      if (parsed.length === 0) {
        text += `${CALL_OPEN}${inner}${CALL_CLOSE}`;
        continue;
      }
      for (const call of parsed) {
        this.#callCount += 1;
        calls.push(call);
      }
    }
    return { text, calls };
  }

  flush(): string {
    const held = this.#pending;
    this.#pending = "";
    if (this.#state === "call") {
      const unclosed = `${CALL_OPEN}${this.#block}`;
      this.#block = "";
      this.#state = "text";
      return held + unclosed;
    }
    return held;
  }

  /** Number of calls recovered so far; used to detect a tool turn. */
  get callCount(): number {
    return this.#callCount;
  }
}

/** Renders one tool result's content as plain text for the prompt. */
function toolResultText(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.kind === "text" ? part.text : JSON.stringify(part)))
    .join("\n");
}

/**
 * The tool contract appended to the system prompt. Written as the convention
 * MiMo models already emit rather than an invented one, and stated once so a
 * long history does not repeat it per turn.
 */
export function renderMimoStudioToolInstruction(tools: readonly ToolDefinition[]): string {
  const lines = tools.map((tool) => {
    const description = tool.description?.trim();
    const schema = JSON.stringify(tool.jsonSchema);
    return `- ${tool.name}${description ? `: ${description}` : ""}\n  arguments: ${schema}`;
  });
  return [
    "You can call tools. To call one, emit only this block:",
    `${CALL_OPEN}${FUNCTION_OPEN}NAME><parameter=KEY>VALUE</parameter>${FUNCTION_CLOSE}${CALL_CLOSE}`,
    "Repeat the `<parameter=…>` element for each argument; nest JSON in VALUE for object or array arguments.",
    "Emit only tool-call blocks when calling a tool, and wait for the result before answering.",
    "Available tools:",
    ...lines,
  ].join("\n");
}

/** Renders one replayed tool call as the block the model itself emits. */
function renderToolCallBlock(part: Extract<ContentPart, { kind: "toolCall" }>): string {
  let parameters = "";
  const raw = part.arguments;
  if (raw !== undefined && raw !== null) {
    let parsed: unknown = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const rendered = typeof value === "string" ? value : JSON.stringify(value);
        parameters += `${PARAMETER_OPEN}${key}>${rendered}${PARAMETER_CLOSE}`;
      }
    }
  }
  return `${CALL_OPEN}${FUNCTION_OPEN}${part.name}>${parameters}${FUNCTION_CLOSE}${CALL_CLOSE}`;
}

/**
 * Rewrites tool turns into the model's text convention so a tool loop can
 * continue across dispatches. The bot endpoint has no structured tool
 * transport, so history tool calls and results travel as the same blocks the
 * model produces, and `tool` turns are re-homed to `user` because the upstream
 * accepts only user and assistant turns.
 */
export function toMimoStudioToolHistory(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message) => {
    let converted = false;
    const texts: string[] = [];
    const kept: ContentPart[] = [];
    for (const part of message.content) {
      if (part.kind === "toolCall") {
        converted = true;
        texts.push(`\n${renderToolCallBlock(part)}`);
      } else if (part.kind === "toolResult") {
        converted = true;
        texts.push(`\n${RESULT_OPEN}\n${toolResultText(part.content)}\n${RESULT_CLOSE}`);
      } else {
        kept.push(part);
      }
    }
    if (!converted) return message;
    const text = texts.join("").trim();
    return {
      ...message,
      role: message.role === "tool" ? ("user" as const) : message.role,
      content: [{ kind: "text", text: text.length > 0 ? `${text}\n` : "" } as ContentPart, ...kept],
    };
  });
}

function isTextDelta(event: CanonicalEvent): event is Extract<CanonicalEvent, { type: "content_delta" }> & {
  content: { kind: "text"; text: string };
} {
  return (
    event.type === "content_delta" &&
    event.content.kind === "text" &&
    typeof (event.content as { text?: unknown }).text === "string"
  );
}

/**
 * Converts tool blocks in a Studio answer into canonical `tool_call_delta`
 * events. Skipped entirely when the request declares no tools, or forbids
 * them: without declared tools a block is prose, and inventing calls would
 * break the client.
 */
export async function* extractMimoStudioToolCalls(
  request: CanonicalRequest,
  source: AsyncIterable<CanonicalEvent>,
): AsyncIterable<CanonicalEvent> {
  if ((request.tools?.length ?? 0) === 0 || request.tool_choice === "none") {
    yield* source;
    return;
  }
  const extractor = new MimoStudioToolExtractor();
  let lastSeq = 0;
  let extractedAny = false;
  for await (const event of source) {
    lastSeq = event.sequence_number;
    if (isTextDelta(event)) {
      const { text, calls } = extractor.push(event.content.text);
      if (text.length > 0) yield { ...event, content: { kind: "text", text } };
      for (const call of calls) {
        extractedAny = true;
        lastSeq += 1;
        yield {
          type: "tool_call_delta",
          sequence_number: lastSeq,
          call_id: `call_${lastSeq}`,
          name: call.name,
          arguments_delta: call.arguments,
        };
      }
      continue;
    }
    if (event.type === "terminal") {
      const trailing = extractor.flush();
      if (trailing.length > 0) {
        lastSeq += 1;
        yield { type: "content_delta", sequence_number: lastSeq, content: { kind: "text", text: trailing } };
      }
      if (
        extractedAny &&
        event.state === "complete" &&
        (event.stop_reason === "stop" || event.stop_reason === undefined)
      ) {
        yield { ...event, stop_reason: "tool_use" as const };
        continue;
      }
      yield event;
      continue;
    }
    yield event;
  }
}
