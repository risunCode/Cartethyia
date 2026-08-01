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
import { encodeOpenAIChatStream } from "../../upstream/bridge";
import { createRequestTracker } from "../tracking/tracker";
import { finishSurfaceDispatch } from "../../routes/dispatch-surface";
import { openAIClientError } from "../../http/errors";
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
// array (dispatchQualifiedRoute forwards the request body as-is, so both
// shapes reach the provider unchanged, same as any real vision-capable
// client request).
const ContentPartSchema = t.Union([
  t.Object({ type: t.Literal("text"), text: t.String() }),
  t.Object({ type: t.Literal("image_url"), image_url: t.Object({ url: t.String() }) }),
]);
const ChatMessageSchema = t.Object({
  role: t.Union([t.Literal("system"), t.Literal("user"), t.Literal("assistant")]),
  content: t.Union([t.String(), t.Array(ContentPartSchema)]),
});

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

      const outboundBody: Record<string, unknown> = { model, messages, stream: body.stream, max_tokens: body.maxTokens ?? 4096 };
      if (body.reasoningEffort) outboundBody.reasoning_effort = body.reasoningEffort;

      // Same tracker every /v1/* proxy route uses, tagged distinctly (REQ) so
      // it's identifiable as a console test rather than live traffic \u2014 the
      // console log line and usage-history row it produces are otherwise
      // identical to real proxy traffic (REQ-console-log-unify).
      const tracker = createRequestTracker({
        endpoint: "/console/api/model-studio/chat",
        surface: "chat",
        model,
        stream: body.stream,
        request,
        apiKey: null,
        meta: { kind: "model-studio" },
      });

      const qualified = await dispatchQualifiedRoute({
        model,
        body: outboundBody,
        headers: {},
        request,
        surface: "openai-chat",
      });

      return finishSurfaceDispatch({
        qualified,
        set,
        tracker,
        requestBody: outboundBody,
        clientError: openAIClientError,
        streamFormat: "openai-chat",
        encodeStream: encodeOpenAIChatStream,
        idPrefix: "chatcmpl",
        model,
        toSurfaceJson: (b) => b,
      });
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
