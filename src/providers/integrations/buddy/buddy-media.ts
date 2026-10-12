/**
 * Buddy-family media generation: image and video.
 *
 * CodeBuddy (intl) and WorkBuddy serve media through the same facade, so the
 * request shaping and the upstream call are shared here rather than copied per
 * provider. Only the identity headers differ, and those come from
 * {@link codebuddyHeaders} keyed on the variant.
 *
 * Two surfaces, two contracts:
 *
 * - **Image** (`gemini-*-flash-image`, `gpt-image-*`) is a *chat* model. cb
 *   answers it on `/chat/completions`, not on an OpenAI `/images/generations`
 *   path, and it enforces the same buddy chat contract every other model does:
 *   the wire must open with a `system` turn (error `11128` otherwise) and it
 *   must be streamed (`11101` on a non-stream body). So {@link
 *   buddyGenerateImage} builds a chat body and runs it through the very same
 *   {@link buddyPrePayloadCommon} + {@link applyBuddySystemPrompt} the chat
 *   dispatch uses — the shaping is proven, not reinvented.
 *
 * - **Video** (`seedance-2.5`) is a native async task. cb accepts a submit and
 *   returns `{data:{id,status:"queued"}}`; the finished clip is fetched from a
 *   sibling task endpoint. {@link buddyGenerateVideo} submits, then polls that
 *   endpoint until the task leaves the queued/running states.
 *
 * ⚠️ Two seams below are implemented against the contract observed live but NOT
 * end-to-end verified, because the operator's CodeBuddy account was out of
 * credits (`14018`) and then quota-cooled before a successful media response
 * could be captured:
 *
 * 1. the exact field cb carries the finished image in (image is extracted
 *    defensively — markdown links and inline base64 both handled);
 * 2. the video task-query path (polled at `<submit-dir>/<task-id>`, the natural
 *    sibling of the submit endpoint). If cb names it differently, that one
 *    constant is the only line to correct after a live probe.
 */
import { OpenAICompatibleAdapter, authHeaders, type OpenAICompatibleAdapterConfig } from "../../compatible-adapter";
import { GatewayError } from "../../../protocol/gateway-error";
import { isRecord, joinUrl } from "../../../protocol/codecs";
import { decodeSseEvents } from "../../../protocol/sse-decoder";
import { postUpstreamJson } from "../../../protocol/upstream/post-json";
import { imageCreatedSeconds, imagePrompt } from "../../../protocol/image-generation";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import type { ImageGenerationOutcome, ProviderDispatchContext, ProviderDispatchTarget, ValidatedOutboundFetch } from "../../contracts";
import { codebuddyHeaders, type CodeBuddyVariant } from "./codebuddy-shared";
import { applyBuddySystemPrompt, buddyPrePayloadCommon } from "./buddy-chat-shared";

/** Media adapter identity: the variant's headers, its leading system turn, and base URL. */
export interface BuddyMediaConfig {
  readonly variant: CodeBuddyVariant;
  readonly systemPrompt: string;
  readonly baseUrl: string;
  readonly buildHeaders?: (context: ProviderDispatchContext) => Promise<Record<string, string>>;
}

async function mediaIdentityHeaders(
  config: BuddyMediaConfig,
  context: ProviderDispatchContext,
): Promise<Record<string, string>> {
  return config.buildHeaders
    ? config.buildHeaders(context)
    : codebuddyHeaders(config.variant, context);
}

function outbound(context: ProviderDispatchContext): ValidatedOutboundFetch {
  return context.outbound_fetch ?? (globalThis.fetch as unknown as ValidatedOutboundFetch);
}

function bearer(context: ProviderDispatchContext): Record<string, string> {
  return authHeaders("authorization_bearer", context.credential.secret, context.credential.credential_kind);
}

function modelOf(body: Record<string, unknown>, candidate: ProviderDispatchTarget): string {
  return candidate.model_id.length > 0 ? candidate.model_id : typeof body.model === "string" ? body.model : "";
}

/**
 * Extracts generated images from the accumulated chat text.
 *
 * A chat-carried image surfaces as either a markdown link (`![img](url)`) or an
 * inline `data:` URI, depending on how the upstream chose to inline it. Both are
 * handled; anything else is treated as "no image" by the caller.
 */
export function extractChatImages(text: string): Record<string, unknown>[] {
  const images: Record<string, unknown>[] = [];
  for (const match of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = match[1];
    if (url !== undefined) images.push({ url });
  }
  for (const match of text.matchAll(/data:image\/([A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g)) {
    const subtype = match[1];
    const b64 = match[2];
    if (subtype !== undefined && b64 !== undefined) {
      images.push({ b64_json: b64, mime_type: `image/${subtype}` });
    }
  }
  return images;
}

/**
 * Generates an image through the buddy chat wire.
 *
 * Reuses the chat payload hook so the body cb accepts (leading `system` turn +
 * typed user content + `stream:true`) is byte-for-byte the one the chat route
 * sends. The streamed chunks are collected and their `content` concatenated,
 * then {@link extractChatImages} pulls the image out.
 */
export async function buddyGenerateImage(
  config: BuddyMediaConfig,
  body: Record<string, unknown>,
  candidate: ProviderDispatchTarget,
  context: ProviderDispatchContext,
): Promise<ImageGenerationOutcome> {
  const model = modelOf(body, candidate);
  if (model.length === 0) throw new GatewayError("invalid_request", 400, "model is required");
  const prompt = imagePrompt(body);
  const payload: Record<string, unknown> = {
    model,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  };
  // The exact chat shaping: role normalization, stream, reasoning, then the
  // leading system turn and typed content.
  buddyPrePayloadCommon(payload, undefined, context);
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    applyBuddySystemPrompt(messages as Array<Record<string, unknown>>, config.systemPrompt);
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...bearer(context),
    ...(await mediaIdentityHeaders(config, context)),
  };
  const lifecycle = createUpstreamDeadlineLifecycle(context);
  let response: Response;
  try {
    response = await outbound(context)(joinUrl(config.baseUrl, candidate.endpoint_path), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: lifecycle.signal,
    });
  } catch (error: unknown) {
    const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
    if (abortError) throw abortError;
    throw new GatewayError(
      "platform_unavailable",
      502,
      `CodeBuddy image generation unreachable: ${error instanceof Error ? error.message : String(error)}`,
      {},
      "upstream",
    );
  } finally {
    lifecycle.release();
  }
  if (!response.ok) {
    throw await mapUpstreamHttpError(response, "codebuddy");
  }
  const contentType = response.headers.get("content-type") ?? "";
  // cb reports a refusal (exhausted credits, a blocked request) as an HTTP 200
  // JSON body, not as an SSE stream. Decoding that as SSE yields nothing and
  // would mask the real reason behind "no image".
  if (!contentType.includes("text/event-stream")) {
    const parsed: unknown = await response.json().catch(() => null);
    const message = buddyErrorOf(parsed) ?? "CodeBuddy image generation returned a non-stream body";
    throw new GatewayError("platform_unavailable", 502, message, {}, "upstream");
  }
  let content = "";
  for await (const event of decodeSseEvents(response.body, { signal: context.abort_signal })) {
    const data = event.data.trim();
    if (data.length === 0 || data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (isRecord(parsed.error)) {
      const message = isRecord(parsed.error) && typeof parsed.error.message === "string" ? parsed.error.message : "CodeBuddy image generation failed";
      throw new GatewayError("platform_unavailable", 502, message, {}, "upstream");
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || !isRecord(choices[0])) continue;
    const delta = (choices[0] as Record<string, unknown>).delta;
    if (isRecord(delta) && typeof delta.content === "string") content += delta.content;
  }
  const images = extractChatImages(content);
  if (images.length === 0) {
    throw new GatewayError(
      "platform_unavailable",
      502,
      "CodeBuddy image generation returned no image in the chat stream",
      {},
      "upstream",
    );
  }
  return { created: imageCreatedSeconds(), data: images };
}

/** States a seedance task sits in before its clip is ready. */
const VIDEO_PENDING = new Set(["queued", "pending", "running", "in_progress", "processing", "generating"]);
/** Bound on task polling so a stuck task cannot hold the request open forever. */
const VIDEO_POLL_TIMEOUT_MS = 180_000;
const VIDEO_POLL_INTERVAL_MS = 3_000;

function taskIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : payload;
  const id = data.id ?? data.task_id ?? data.taskId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function videoUrlOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : payload;
  const content = isRecord(data.content) ? data.content : undefined;
  const candidates = [content?.video_url, data.video_url, data.url, content?.url];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function videoStatusOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : payload;
  const status = data.status;
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

/**
 * Digs cb's own error message out of a response envelope.
 *
 * cb reports failures — exhausted credits, a refused request — as an HTTP 200
 * JSON body `{error:{data:{code,msg}}}`, not as a non-2xx status and not as an
 * SSE `error` frame. Surfacing `msg` verbatim is the difference between "top up
 * your credits" and a generic "returned no image".
 */
export function buddyErrorOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (!isRecord(error)) return undefined;
  const data = isRecord(error.data) ? error.data : error;
  const msg = data.msg ?? data.message ?? error.msg ?? error.message;
  if (typeof msg === "string" && msg.trim().length > 0) return msg.trim();
  const code = data.code ?? error.code;
  return typeof code === "number" || typeof code === "string" ? `CodeBuddy error ${code}` : "CodeBuddy request failed";
}

/**
 * Generates a video through the buddy native task API.
 *
 * Submits `{model, prompt}` to the video endpoint, then polls the task until it
 * reports a finished clip. The submit endpoint is `candidate.endpoint_path`
 * (`/videos/generations`); the poll hits its sibling `<dir>/<task-id>`.
 *
 * ⚠️ The poll path is the natural sibling of the submit endpoint and is NOT
 * verified against a live cb response (see the module header). If cb names the
 * query route differently, {@link VIDEO_TASK_PATH} is the one line to correct.
 */
export async function buddyGenerateVideo(
  config: BuddyMediaConfig,
  body: Record<string, unknown>,
  candidate: ProviderDispatchTarget,
  context: ProviderDispatchContext,
): Promise<Record<string, unknown>> {
  const model = modelOf(body, candidate);
  if (model.length === 0) throw new GatewayError("invalid_request", 400, "model is required");
  const prompt = imagePrompt(body);
  const submitBody: Record<string, unknown> = { model, prompt };
  if (typeof body.n === "number" && Number.isFinite(body.n)) submitBody["n"] = Math.max(1, Math.floor(body.n));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...bearer(context),
    ...(await mediaIdentityHeaders(config, context)),
  };
  const submitPath = candidate.endpoint_path;
  const submitUrl = joinUrl(config.baseUrl, submitPath);
  const { res, release } = await postUpstreamJson(
    submitUrl,
    headers,
    submitBody,
    context,
    outbound(context),
  );
  let submitted: unknown;
  try {
    if (!res.ok) {
      throw await mapUpstreamHttpError(res, "codebuddy");
    }
    submitted = await res.json();
  } finally {
    release();
  }
  const taskId = taskIdOf(submitted);
  if (taskId === undefined) {
    // A synchronous result already carries the clip; hand it straight back.
    const url = videoUrlOf(submitted);
    if (url !== undefined) return { data: [{ url }] };
    // Otherwise cb refused (HTTP 200 error envelope) — surface its own reason.
    const message = buddyErrorOf(submitted) ?? "CodeBuddy video submit returned no task id";
    throw new GatewayError("platform_unavailable", 502, message, {}, "upstream");
  }
  // Poll the sibling task endpoint until the clip is ready.
  const taskPath = `${submitUrl.replace(/\/+$/, "")}/${taskId}`;
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  for (;;) {
    if (context.abort_signal?.aborted) {
      throw new GatewayError("transport_closed", 499, "video generation aborted");
    }
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    let statusRes: Response;
    try {
      statusRes = await outbound(context)(taskPath, {
        method: "GET",
        headers: { accept: "application/json", ...bearer(context), ...(await mediaIdentityHeaders(config, context)) },
        signal: lifecycle.signal,
      });
    } catch (error: unknown) {
      const abortError = abortGatewayError(lifecycle, error, context.abort_signal);
      if (abortError) throw abortError;
      throw new GatewayError("platform_unavailable", 502, `CodeBuddy video status unreachable: ${error instanceof Error ? error.message : String(error)}`, {}, "upstream");
    } finally {
      lifecycle.release();
    }
    if (!statusRes.ok) {
      throw await mapUpstreamHttpError(statusRes, "codebuddy");
    }
    const payload: unknown = await statusRes.json();
    const url = videoUrlOf(payload);
    if (url !== undefined) return { data: [{ url }], task_id: taskId };
    const status = videoStatusOf(payload);
    if (status !== undefined && !VIDEO_PENDING.has(status)) {
      throw new GatewayError("platform_unavailable", 502, `CodeBuddy video task ended in state "${status}" with no clip`, {}, "upstream");
    }
    if (Date.now() > deadline) {
      throw new GatewayError("platform_unavailable", 504, `CodeBuddy video task ${taskId} did not finish within ${VIDEO_POLL_TIMEOUT_MS}ms`, {}, "upstream");
    }
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
  }
}

/**
 * Chat-compatible adapter that also serves the buddy media surfaces.
 *
 * Extends {@link OpenAICompatibleAdapter} so every chat behavior (headers,
 * payload hook, transport) is inherited unchanged; it only adds the two media
 * methods the generation routes call.
 */
export class BuddyMediaAdapter extends OpenAICompatibleAdapter {
  readonly #media: BuddyMediaConfig;

  constructor(config: OpenAICompatibleAdapterConfig, media: BuddyMediaConfig) {
    super(config);
    this.#media = media;
  }

  async generateImage(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<ImageGenerationOutcome> {
    return buddyGenerateImage(this.#media, body, candidate, context);
  }

  async generateVideo(
    body: Record<string, unknown>,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<Record<string, unknown>> {
    return buddyGenerateVideo(this.#media, body, candidate, context);
  }
}
