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
import { runEmulatedCompact, CompactError } from "../../routes/compact-core";
import type { OpenAIChatRequest } from "../../translate/types";
import {
  listStudioSessions,
  getStudioSession,
  createStudioSession,
  patchStudioSession,
  deleteStudioSession,
} from "../db/repos/model-studio";

const UsageSchema = t.Object({
  inputTokens: t.Number(),
  outputTokens: t.Number(),
  reasoningTokens: t.Number(),
  cachedTokens: t.Number(),
  totalTokens: t.Number(),
  source: t.Union([t.Literal("provider"), t.Literal("estimated")]),
});

const MessageSchema = t.Object({
  role: t.Union([t.Literal("system"), t.Literal("user"), t.Literal("assistant")]),
  content: t.String(),
  ts: t.String(),
  usage: t.Optional(UsageSchema),
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
    "/compact",
    async ({ body, set, request }) => {
      const model = body.model.trim();
      if (!model) {
        set.status = 400;
        return consoleError("invalid_request", "model is required");
      }
      const messages = [
        ...(body.systemPrompt?.trim() ? [{ role: "system" as const, content: body.systemPrompt }] : []),
        ...body.messages.map(({ role, content }) => ({ role, content })),
      ];
      if (messages.length < 2) {
        set.status = 400;
        return consoleError("invalid_request", "at least two messages are required to compact");
      }
      const tracker = createRequestTracker({
        endpoint: "/console/api/model-studio/compact",
        surface: "chat",
        model,
        stream: false,
        request,
        apiKey: null,
        meta: { kind: "model-studio", compact: true },
      });
      const requestBody = { model, messages, max_tokens: body.maxTokens ?? 4096 };
      try {
        const { text, response } = await runEmulatedCompact({
          model,
          chatReq: requestBody as OpenAIChatRequest,
          headers: {},
          request,
        });
        return tracker.finishJson(200, { summary: text, usage: response.usage }, undefined, requestBody);
      } catch (err) {
        if (err instanceof CompactError) {
          set.status = err.status;
          tracker.fail(err.status, "compact_error", requestBody, err.message);
          return openAIClientError(err.status, err.status === 401 || err.status === 403 ? "authentication_error" : "invalid_request_error", err.message);
        }
        tracker.fail(500, "internal_error", requestBody);
        throw err;
      }
    },
    {
      body: t.Object({
        model: t.String(),
        messages: t.Array(ChatMessageSchema),
        systemPrompt: t.Optional(t.String()),
        maxTokens: t.Optional(t.Number()),
      }),
    },
  )
  .post(
    "/chat",
    async ({ body, set, request, server }) => {
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
      // it's identifiable as a console test rather than live traffic — the
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
        clientIp: server?.requestIP(request)?.address,
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
