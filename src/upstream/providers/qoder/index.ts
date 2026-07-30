import { createHash } from "node:crypto";
import type { RouteTarget } from "../../../routing/types";
import type { OpenAIChatRequest } from "../../../translate/types";
import { decodeOpenAIChatStream } from "../../bridge";
import { materializeFromStream, materializedToChatResponse } from "../../result";
import { ProviderCallError, providerHttpError, safeReadText } from "../index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "../index";
import { qoderModelCatalog, QODER_MODEL_CONFIGS, type QoderModelConfig } from "./models";
import { callQoder, exchangeQoderPat, QODER_CHAT_URL, type QoderAuth } from "./protocol";

class QoderProvider implements Provider {
  readonly id = "qoder" as const;
  readonly display = {
    name: "Qoder",
    icon: "qoder",
    authKind: "api-key",
    authHint: "Use your Qoder personal access token from the Qoder CLI credential store.",
    credentialUrl: "https://qoder.com",
  } as const;
  readonly models = qoderModelCatalog;

  resolveTarget(modelId: string): RouteTarget | undefined {
    return {
      provider: "qoder",
      modelId,
      surface: "openai-chat",
      credential: "qoder-pat",
      weight: 1,
    };
  }

  async call(
    target: RouteTarget,
    request: ProviderRequest,
    credential: ResolvedCredential,
    signal: AbortSignal,
    _proxy?: string
  ): Promise<ProviderResult> {
    if (credential.kind !== "qoder-pat") {
      throw new ProviderCallError(401, "authentication", "A Qoder personal access token is required.");
    }
    if (request.surface !== "openai-chat") {
      throw new ProviderCallError(400, "invalid_request", "Qoder currently supports the OpenAI Chat shape.");
    }

    const auth = await exchangeQoderPat(credential.value, signal);
    const modelConfig = QODER_MODEL_CONFIGS[target.modelId];
    if (!modelConfig) {
      throw new ProviderCallError(400, "invalid_request", `Qoder model "${target.modelId}" is not supported.`);
    }

    const chatBody = request.body as OpenAIChatRequest;
    const qoderBody = buildQoderRequest(target.modelId, chatBody, modelConfig, auth);
    const response = await callQoder(QODER_CHAT_URL, qoderBody, target.modelId, auth, signal);
    if (!response.ok) {
      throw providerHttpError(response.status, "Qoder", undefined, await safeReadText(response));
    }
    if (!response.body) {
      throw new ProviderCallError(502, "unavailable", "Qoder returned an empty response body.");
    }

    const events = decodeOpenAIChatStream(unwrapQoderStream(response.body));
    if (chatBody.stream === true) return { type: "stream", events };

    const materialized = await materializeFromStream(events);
    return { type: "json", body: materializedToChatResponse(materialized, chatBody.model) as unknown as Record<string, unknown> };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function stableHash(prefix: string, ...parts: string[]): string {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) { h.update("\0"); h.update(p); }
  return h.digest("hex").slice(0, 16);
}

function stableRecordId(modelId: string, messages: Array<{ role?: string; content?: unknown }>, maxTokens: number): string {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(modelId);
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    const text = flattenContent(m.content);
    if (text) { h.update("\0"); h.update(text); }
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function buildQoderRequest(
  modelId: string,
  body: OpenAIChatRequest,
  modelConfig: QoderModelConfig,
  auth: QoderAuth,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages
    .filter((m) => m?.role === "system")
    .map((m) => flattenContent(m.content))
    .filter(Boolean)
    .join("\n\n");
  const qoderMessages = messages
    .filter((m) => m?.role !== "system")
    .map((m) => {
      const flat = flattenContent(m.content);
      return { ...m, content: flat, contents: [{ type: "text", text: flat }] };
    });
  const latestUserText = [...qoderMessages].reverse().find((m) => m.role === "user")?.content ?? "";
  const maxTokens = requestedMaxTokens(body, modelConfig);
  const reasoning = modelConfig.is_reasoning === true;

  // Stable IDs for cache hits (aligned with 9router):
  //   session_id  = hash(userId + modelKey) → same user+model = same session
  //   record_id   = hash(model + messages + maxTokens) → same conversation = same record
  const sessionId = stableHash("qoder-session", auth.userId, modelId);
  const recordId = stableRecordId(modelId, messages, maxTokens);

  return {
    request_id: crypto.randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionId,
    stream: true,
    aliyun_user_type: "",
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    // chat_context: plain strings (9router-compatible, not objects)
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelId, is_reasoning: reasoning },
        originalContent: latestUserText,
      },
      features: [],
      text: latestUserText,
    },
    model_config: {
      key: modelId,
      display_name: modelConfig.display_name,
      is_vl: modelConfig.is_vl,
      is_reasoning: modelConfig.is_reasoning,
      max_input_tokens: modelConfig.max_input_tokens,
      format: "openai",
      source: "system",
    },
    system,
    messages: qoderMessages,
    tools: Array.isArray(body.tools) ? body.tools : [],
    parameters: { max_tokens: maxTokens },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: latestUserText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")
    .join("\n");
}

function requestedMaxTokens(body: OpenAIChatRequest, modelConfig: QoderModelConfig): number {
  const configured = typeof modelConfig.max_output_tokens === "number" ? modelConfig.max_output_tokens : 32768;
  const requested = body.max_tokens ?? body.max_completion_tokens;
  return typeof requested === "number" && requested > 0 ? Math.min(requested, configured) : configured;
}

// ── SSE unwrap ───────────────────────────────────────────────────────────

function unwrapQoderStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let doneEmitted = false;

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drainQoderLines(controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) emitQoderLine(buffer, controller);
      if (!doneEmitted) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneEmitted = true;
      }
    },
  }));

  function drainQoderLines(controller: TransformStreamDefaultController<Uint8Array>): void {
    let separator = buffer.indexOf("\n");
    while (separator !== -1) {
      const line = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 1);
      emitQoderLine(line, controller);
      separator = buffer.indexOf("\n");
    }
  }

  function emitQoderLine(line: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (doneEmitted) return;
    const data = line.trim().startsWith("data:") ? line.trim().slice(5).trimStart() : "";
    if (!data) return;
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    let envelope: { statusCodeValue?: number; body?: string };
    try {
      envelope = JSON.parse(data) as { statusCodeValue?: number; body?: string };
    } catch {
      return; // skip malformed lines instead of throwing
    }
    if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 200) {
      // Inject error into stream instead of throwing (9router pattern)
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "qoder",
        choices: [{ index: 0, delta: { content: `\n[qoder error ${envelope.statusCodeValue}]` }, finish_reason: "stop" }],
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    if (envelope.body === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneEmitted = true;
      return;
    }
    if (typeof envelope.body !== "string") {
      // Qoder finish event (firstTokenDuration, totalDuration, etc.) — skip.
      if ("firstTokenDuration" in envelope || "totalDuration" in envelope) return;
      return; // skip unknown envelope shapes
    }
    // Strip embedded newlines so SSE frame stays a single event (9router pattern)
    const sanitized = envelope.body.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  }
}

export const qoderProvider = new QoderProvider();
