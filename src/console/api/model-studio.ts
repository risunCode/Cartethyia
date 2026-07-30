/**
 * Model Studio — console-authenticated chat playground. Reuses the exact
 * dispatch pipeline every /v1/* proxy route runs through (`dispatchQualifiedRoute`:
 * combo/alias resolution, stored-account credential rotation, system-prompt
 * injection, filter rules) so a test here behaves like a real client request,
 * without requiring a Cartethyia API key. Sessions are config-state CRUD only;
 * the actual completion call never touches the DB directly.
 */

import { Elysia, t } from "elysia";
import { consoleError } from "../errors";
import { dispatchQualifiedRoute } from "../../upstream/dispatch";
import type { StreamEvent } from "../../upstream/bridge";
import { encodeOpenAIChatStream, withStreamErrorHandling } from "../../upstream/bridge";
import { toSSEResponseStream } from "../../upstream/sse";
import { providerForModel } from "../tracking/tracker";
import { insertUsageHistory, utcNow } from "../db/repos/usage";
import { extractUsage } from "../tracking/usage-extractor";
import { pushConsoleLog } from "../logs/ring";
import {
  listStudioSessions,
  getStudioSession,
  createStudioSession,
  patchStudioSession,
  deleteStudioSession,
} from "../db/repos/model-studio";

const MessageSchema = t.Object({
  role: t.Union([t.Literal("system"), t.Literal("user"), t.Literal("assistant")]),
  content: t.String(),
  ts: t.String(),
  // Data-URL image attachments (user turns only) — stored alongside the
  // caption text so a reloaded session still shows what was sent.
  images: t.Optional(t.Array(t.String())),
});

// The chat call itself never persists `ts` — only session PATCH does — so it
// stays out of this schema instead of forcing every caller to fabricate one.
// `content` accepts the plain-string shape or the OpenAI multimodal parts
// array (dispatchQualifiedRoute → prepareOutboundRequest already understands
// both, same as any real vision-capable client request).
const ContentPartSchema = t.Union([
  t.Object({ type: t.Literal("text"), text: t.String() }),
  t.Object({ type: t.Literal("image_url"), image_url: t.Object({ url: t.String() }) }),
]);
const ChatMessageSchema = t.Object({
  role: t.Union([t.Literal("system"), t.Literal("user"), t.Literal("assistant")]),
  content: t.Union([t.String(), t.Array(ContentPartSchema)]),
});

/** Records one Model Studio completion into the same usage history the real proxy writes to, tagged distinctly so it's identifiable as a console test rather than live traffic. */
function recordUsage(input: {
  model: string;
  started: number;
  status: number;
  stream: boolean;
  usage?: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; cacheWriteTokens: number | null; totalTokens: number | null; source: string };
}): void {
  const finishedAt = utcNow();
  insertUsageHistory({
    traceId: crypto.randomUUID(),
    endpoint: "/console/model-studio",
    surface: "chat",
    apiKeyId: null,
    apiKeyPrefix: null,
    provider: providerForModel(input.model) ?? null,
    model: input.model,
    status: input.status,
    errorKind: input.status >= 400 ? "dispatch_error" : null,
    stream: input.stream,
    startedAt: finishedAt,
    finishedAt,
    durationMs: Math.round(performance.now() - input.started),
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    cachedTokens: input.usage?.cachedTokens ?? null,
    cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
    reasoningTokens: null,
    totalTokens: input.usage?.totalTokens ?? null,
    usageSource: input.usage?.source ?? "missing",
    meta: { kind: "model-studio" },
  });
}

/** Tees the "usage" event out of a provider stream so it can be logged once the stream finishes, without buffering the text itself. */
async function* trackStreamUsage(events: AsyncGenerator<StreamEvent>, onDone: (usage: Extract<StreamEvent, { type: "usage" }> | undefined) => void): AsyncGenerator<StreamEvent> {
  let usage: Extract<StreamEvent, { type: "usage" }> | undefined;
  try {
    for await (const event of events) {
      if (event.type === "usage") usage = event;
      yield event;
    }
  } finally {
    onDone(usage);
  }
}

export const modelStudioRoutes = new Elysia({ prefix: "/console/api/model-studio" })
  .get("/sessions", () => ({ items: listStudioSessions() }))
  .get("/sessions/:id", ({ params, set }) => {
    const session = getStudioSession(params.id);
    if (!session) {
      set.status = 404;
      return consoleError("not_found", "session not found");
    }
    return session;
  })
  .post(
    "/sessions",
    ({ body }) => createStudioSession({ title: body.title ?? "New session", model: body.model, systemPrompt: body.systemPrompt }),
    { body: t.Object({ title: t.Optional(t.String()), model: t.Optional(t.String()), systemPrompt: t.Optional(t.String()) }) }
  )
  .patch(
    "/sessions/:id",
    ({ params, body, set }) => {
      const updated = patchStudioSession(params.id, body);
      if (!updated) {
        set.status = 404;
        return consoleError("not_found", "session not found");
      }
      return updated;
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        model: t.Optional(t.String()),
        systemPrompt: t.Optional(t.String()),
        messages: t.Optional(t.Array(MessageSchema)),
      }),
    }
  )
  .delete("/sessions/:id", ({ params, set }) => {
    if (!deleteStudioSession(params.id)) {
      set.status = 404;
      return consoleError("not_found", "session not found");
    }
    return { ok: true };
  })
  .post(
    "/chat",
    async ({ body, set, request }) => {
      const model = body.model.trim();
      if (!model) {
        set.status = 400;
        return consoleError("invalid_request", "model is required");
      }
      const messages = body.messages.map(({ role, content }) => ({ role, content }));
      if (messages.length === 0) {
        set.status = 400;
        return consoleError("invalid_request", "at least one message is required");
      }

      const started = performance.now();
      const outboundBody: Record<string, unknown> = { model, messages, stream: body.stream, max_tokens: body.maxTokens ?? 4096 };
      if (body.reasoningEffort) outboundBody.reasoning_effort = body.reasoningEffort;
      const qualified = await dispatchQualifiedRoute({
        model,
        body: outboundBody,
        headers: {},
        request,
        surface: "openai-chat",
      });

      if (qualified.kind === "error") {
        set.status = qualified.status;
        recordUsage({ model, started, status: qualified.status, stream: body.stream });
        pushConsoleLog("warn", "model-studio", `${model}: ${qualified.message}`);
        return consoleError(qualified.status === 401 || qualified.status === 403 ? "unauthorized" : "invalid_request", qualified.message);
      }

      const { result } = qualified;
      if (result.type === "stream") {
        set.headers["content-type"] = "text/event-stream";
        const meta = { id: `chatcmpl-${crypto.randomUUID()}`, model, createdAt: Math.floor(Date.now() / 1000) };
        const tracked = trackStreamUsage(result.events, (usage) => {
          recordUsage({
            model,
            started,
            status: 200,
            stream: true,
            usage: usage
              ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, totalTokens: usage.inputTokens + usage.outputTokens, source: "stream" }
              : undefined,
          });
        });
        return toSSEResponseStream(withStreamErrorHandling(encodeOpenAIChatStream(tracked, meta), "openai-chat"));
      }

      const usage = extractUsage("chat", result.body);
      recordUsage({
        model,
        started,
        status: 200,
        stream: false,
        usage: usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens ?? null, cacheWriteTokens: usage.cacheWriteTokens ?? null, totalTokens: usage.totalTokens, source: usage.source } : undefined,
      });
      return result.body;
    },
    {
      body: t.Object({
        model: t.String(),
        messages: t.Array(ChatMessageSchema),
        stream: t.Boolean(),
        maxTokens: t.Optional(t.Number()),
        reasoningEffort: t.Optional(t.String()),
      }),
    }
  );
