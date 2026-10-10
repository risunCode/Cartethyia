/**
 * Turns a Model Lab conversation into the public gateway body for the wire
 * the operator picked. The lab does not invent a private protocol: chat,
 * responses, and messages are the same surfaces a client would call.
 */

export type LabProtocol = "chat" | "responses" | "messages";
export type LabMode = "agentic" | "media";
export type LabEffort = "auto" | "low" | "medium" | "high" | "max";

export interface LabImage {
  readonly name: string;
  readonly dataUrl: string;
}

export interface LabTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly images?: readonly LabImage[];
}

export interface LabRequestSettings {
  readonly protocol: LabProtocol;
  readonly mode: LabMode;
  readonly model: string;
  readonly systemPrompt: string;
  readonly temperature: string;
  readonly topP: string;
  readonly effort: LabEffort;
}

export interface BuiltLabRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const PATH_BY_PROTOCOL: Record<LabProtocol, string> = {
  chat: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
};

function optionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function sampling(settings: LabRequestSettings): Record<string, number> {
  const temperature = optionalNumber(settings.temperature);
  const topP = optionalNumber(settings.topP);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { top_p: topP }),
  };
}

function reasoning(protocol: LabProtocol, effort: LabEffort): Record<string, unknown> {
  if (effort === "auto") return {};
  // Chat reads a top-level scalar. Responses and Messages read `reasoning.effort`.
  // `max` is the canonical ceiling; the composer label is the same word.
  if (protocol === "chat") return { reasoning_effort: effort };
  return { reasoning: { effort } };
}

function userContent(protocol: LabProtocol, turn: LabTurn): string | readonly Record<string, unknown>[] {
  const images = turn.images ?? [];
  if (images.length === 0) return turn.text;
  if (protocol === "messages") {
    return [
      ...(turn.text.length > 0 ? [{ type: "text", text: turn.text }] : []),
      ...images.map((image) => ({ type: "image", source: { type: "url", url: image.dataUrl } })),
    ];
  }
  if (protocol === "responses") {
    return [
      ...(turn.text.length > 0 ? [{ type: "input_text", text: turn.text }] : []),
      ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl })),
    ];
  }
  return [
    ...(turn.text.length > 0 ? [{ type: "text", text: turn.text }] : []),
    ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
  ];
}

function spokenTurns(turns: readonly LabTurn[]): readonly LabTurn[] {
  return turns.filter((turn) => turn.text.trim().length > 0 || (turn.images?.length ?? 0) > 0);
}



/**
 * The hosted search tool a Model Lab agentic turn declares.
 *
 * A provider proven to serve it natively keeps it. Every other chat route
 * runs the configured search fallback and answers from those results. No
 * function tools are declared: the gateway executes only hosted web search,
 * so any other declared tool ends the turn on `tool_calls` with nobody to
 * run it — which hides the model's answer.
 */
function agentTools(protocol: LabProtocol): readonly Record<string, unknown>[] {
  return [
    protocol === "messages"
      ? { type: "web_search_20250305", name: "web_search" }
      : { type: "web_search" },
  ];
}

function withAgentTools(protocol: LabProtocol, mode: LabMode, body: Record<string, unknown>): Record<string, unknown> {
  if (mode !== "agentic") return body;
  return { ...body, tools: agentTools(protocol) };
}

/** One friendly starter prompt on the Model Lab welcome screen. */
export interface LabPreset {
  readonly label: string;
  readonly prompt: string;
}

export const MODEL_LAB_PRESETS: readonly LabPreset[] = [
  { label: "Search", prompt: "Cari di internet siapa itu risuncode, lalu tuliskan satu URL sumber." },
  { label: "Hello", prompt: "Halo! Perkenalkan dirimu singkat dalam Bahasa Indonesia." },
  { label: "News", prompt: "Cari berita teknologi terbaru hari ini dan ringkas hasilnya." },
  { label: "Translate", prompt: "Cari arti kata \"proxy\" di internet dan jelaskan ringkas dalam Bahasa Indonesia." },
  { label: "Code", prompt: "Cari di internet cara membaca file dengan Bun di TypeScript, lalu berikan contoh singkat." },
];
/** The endpoint and JSON body for one send. Empty assistant turns are dropped. */
export function buildLabRequest(turns: readonly LabTurn[], settings: LabRequestSettings): BuiltLabRequest {
  const spoken = spokenTurns(turns);
  const system = settings.systemPrompt.trim();
  const sample = sampling(settings);
  const effort = reasoning(settings.protocol, settings.effort);

  if (settings.protocol === "messages") {
    return {
      path: PATH_BY_PROTOCOL.messages,
      body: withAgentTools("messages", settings.mode, {
        model: settings.model,
        stream: true,
        max_tokens: 4096,
        ...(system.length > 0 ? { system } : {}),
        messages: spoken.map((turn) => ({ role: turn.role, content: userContent("messages", turn) })),
        ...sample,
        ...effort,
      }),
    };
  }

  if (settings.protocol === "responses") {
    return {
      path: PATH_BY_PROTOCOL.responses,
      body: withAgentTools("responses", settings.mode, {
        model: settings.model,
        stream: true,
        input: [
          ...(system.length > 0 ? [{ role: "system", content: system }] : []),
          ...spoken.map((turn) => ({ role: turn.role, content: userContent("responses", turn) })),
        ],
        ...sample,
        ...effort,
      }),
    };
  }

  return {
    path: PATH_BY_PROTOCOL.chat,
    body: withAgentTools("chat", settings.mode, {
      model: settings.model,
      stream: true,
      messages: [
        ...(system.length > 0 ? [{ role: "system", content: system }] : []),
        ...spoken.map((turn) => ({ role: turn.role, content: userContent("chat", turn) })),
      ],
      ...sample,
      ...effort,
    }),
  };
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Splits one SSE chunk into complete events, keeping a trailing partial frame. */
export function takeSseEvents(buffer: string): { readonly events: readonly SseEvent[]; readonly rest: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = frames.pop() ?? "";
  const events: SseEvent[] = [];
  for (const frame of frames) {
    if (frame.trim().length === 0) continue;
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part === null || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .join("");
}

/**
 * Pulls the visible text delta out of one SSE payload.
 *
 * Chat streams `choices[].delta.content`. Responses streams `delta` on
 * `response.output_text.delta`. Messages streams `delta.text` on
 * `content_block_delta`. A non-delta payload contributes nothing.
 */
export function textDelta(protocol: LabProtocol, eventName: string, payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;

  if (protocol === "chat") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    return choices
      .map((choice) => {
        if (choice === null || typeof choice !== "object") return "";
        const delta = (choice as Record<string, unknown>).delta;
        if (delta === null || typeof delta !== "object") return "";
        const deltaRecord = delta as Record<string, unknown>;
        const reasoning = textOf(deltaRecord.reasoning_content ?? deltaRecord.reasoning);
        if (reasoning.length > 0) return "";
        return textOf(deltaRecord.content);
      })
      .join("");
  }

  if (protocol === "responses") {
    if (eventName !== "response.output_text.delta" && record.type !== "response.output_text.delta") return "";
    return typeof record.delta === "string" ? record.delta : "";
  }

  if (eventName !== "content_block_delta" && record.type !== "content_block_delta") return "";
  const delta = record.delta;
  if (delta === null || typeof delta !== "object") return "";
  return textOf((delta as Record<string, unknown>).text);
}

/** Pulls a thinking delta. Visible answer text stays in `textDelta`. */
export function reasoningDelta(protocol: LabProtocol, eventName: string, payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (protocol === "chat") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    return choices
      .map((choice) => {
        if (choice === null || typeof choice !== "object") return "";
        const delta = (choice as Record<string, unknown>).delta;
        if (delta === null || typeof delta !== "object") return "";
        const body = delta as Record<string, unknown>;
        return textOf(body.reasoning_content ?? body.reasoning);
      })
      .join("");
  }
  if (protocol === "responses") {
    const type = eventName.length > 0 ? eventName : record.type;
    if (type !== "response.reasoning_text.delta" && type !== "response.reasoning_summary_text.delta") return "";
    return typeof record.delta === "string" ? record.delta : "";
  }
  if (eventName !== "content_block_delta" && record.type !== "content_block_delta") return "";
  const delta = record.delta;
  if (delta === null || typeof delta !== "object") return "";
  const body = delta as Record<string, unknown>;
  if (body.type !== "thinking_delta") return "";
  return textOf(body.thinking);

}

/** The name of a tool the model started calling in this frame. */
export function toolCallName(protocol: LabProtocol, eventName: string, payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (protocol === "chat") {
    const choices = record.choices;
    if (!Array.isArray(choices)) return "";
    return choices
      .map((choice) => {
        if (choice === null || typeof choice !== "object") return "";
        const delta = (choice as Record<string, unknown>).delta;
        if (delta === null || typeof delta !== "object") return "";
        const calls = (delta as Record<string, unknown>).tool_calls;
        if (!Array.isArray(calls)) return "";
        return calls
          .map((call) => {
            if (call === null || typeof call !== "object") return "";
            const fn = (call as Record<string, unknown>).function;
            if (fn === null || typeof fn !== "object") return "";
            return textOf((fn as Record<string, unknown>).name);
          })
          .filter((name) => name.length > 0)
          .join(", ");
      })
      .filter((name) => name.length > 0)
      .join(", ");
  }
  if (protocol === "responses") {
    const type = eventName.length > 0 ? eventName : record.type;
    if (type !== "response.output_item.added" && type !== "response.function_call_arguments.delta") return "";
    const item = record.item;
    if (item === null || typeof item !== "object") return textOf(record.name);
    return textOf((item as Record<string, unknown>).name);
  }
  if (eventName !== "content_block_start" && record.type !== "content_block_start") return "";
  const block = record.content_block;
  if (block === null || typeof block !== "object") return "";
  if ((block as Record<string, unknown>).type !== "tool_use") return "";
  return textOf((block as Record<string, unknown>).name);
}

export interface LabUsageDelta {
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly status?: string;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cachedOf(usage: Record<string, unknown>): number | undefined {
  const direct = numberOf(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens);
  if (direct !== undefined) return direct;
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details;
  if (details === null || typeof details !== "object") return undefined;
  return numberOf((details as Record<string, unknown>).cached_tokens);
}

function usageOf(value: unknown): Pick<LabUsageDelta, "inputTokens" | "cachedTokens" | "outputTokens" | "reasoningTokens"> {
  if (value === null || typeof value !== "object") return {};
  const usage = value as Record<string, unknown>;
  const details = usage.output_tokens_details ?? usage.completion_tokens_details;
  const reasoning = details !== null && typeof details === "object"
    ? numberOf((details as Record<string, unknown>).reasoning_tokens)
    : numberOf(usage.reasoning_tokens);
  const inputTokens = numberOf(usage.input_tokens ?? usage.prompt_tokens);
  const cachedTokens = cachedOf(usage);
  const outputTokens = numberOf(usage.output_tokens ?? usage.completion_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

/** Reads token totals and a terminal status when a frame carries them. */
export function usageDelta(protocol: LabProtocol, eventName: string, payload: unknown): LabUsageDelta {
  if (payload === null || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  if (protocol === "chat") {
    const choice = Array.isArray(record.choices) ? record.choices[0] : undefined;
    const finish = choice !== null && typeof choice === "object"
      ? (choice as Record<string, unknown>).finish_reason
      : undefined;
    return {
      ...usageOf(record.usage),
      ...(typeof finish === "string" && finish.length > 0 ? { status: finish } : {}),
    };
  }
  if (protocol === "responses") {
    const response = record.response;
    const done = eventName === "response.completed" || record.type === "response.completed";
    const body = response !== null && typeof response === "object" ? response as Record<string, unknown> : record;
    return {
      ...usageOf(body.usage),
      ...(done ? { status: "completed" } : {}),
    };
  }
  const done = eventName === "message_stop" || record.type === "message_stop";
  const message = record.message;
  const body = message !== null && typeof message === "object" ? message as Record<string, unknown> : record;
  return {
    ...usageOf(body.usage),
    ...(done ? { status: "completed" } : {}),
  };
}

/** Reads `error.message` from a gateway JSON body, or a status fallback. */
export function errorMessage(payload: unknown, status: number): string {
  if (payload !== null && typeof payload === "object") {
    const error = (payload as Record<string, unknown>).error;
    if (error !== null && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim().length > 0) return message;
    }
    const message = (payload as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Request failed (${status})`;
}
