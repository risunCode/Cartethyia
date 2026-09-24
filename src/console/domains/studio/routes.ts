// Studio playground domain: HTTP routes.
//
// Owns validation, access, audit, and web tools; reads and writes sessions
// only through the StudioSessionStore.

import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../../shared/errors";
import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../audit/contracts";
import { isRecord } from "../../../protocol/primitives";
import type { ValidatedFetch } from "../../../network/outbound-fetch";
import { decryptCredentialToString } from "../../../security/crypto";
import { DEFAULT_API_KEY_LABEL } from "../api-keys/contracts";
import {
  boundedString,
  normalizeStudioMessages,
  normalizeStudioMedia,
  toSession,
  toSummary,
  STUDIO_MAX_SESSIONS_PER_TENANT,
  STUDIO_LIMIT_TITLE,
  STUDIO_LIMIT_MODEL,
  STUDIO_LIMIT_SYSTEM_PROMPT,
  type StudioSessionView,
  type StudioSessionRow,
  type StudioSessionSummary,
} from "./contracts";
import type { ApiKeyStore } from "../../../persistence/api-key-store";
import type { StudioSessionStore } from "./contracts";

export interface StudioConfig {
  readonly sessionStore: StudioSessionStore;
  readonly keyStore: ApiKeyStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly webFetch?: (tenantId: string) => ValidatedFetch;
  readonly auditSink?: AuditSink;
}
const MAX_WEB_CHARS = 24_000;
const WEB_TIMEOUT_MS = 15_000;

function webUrl(value: unknown): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConsoleDomainError("invalid_web_url", 400, "url is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConsoleDomainError("invalid_web_url", 400, "url must be absolute");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConsoleDomainError("invalid_web_url", 400, "only http and https URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new ConsoleDomainError("invalid_web_url", 400, "credentialed URLs are not supported");
  }
  return parsed;
}

function htmlText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

async function studioWebFetch(fetcher: ValidatedFetch, value: unknown, maxChars: number): Promise<unknown> {
  const url = webUrl(value);
  const response = await fetcher(url, {
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1", "user-agent": "Cartethyia-Studio/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
  });
  if (!response.ok) throw new ConsoleDomainError("web_fetch_failed", 502, `fetch returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  const content = contentType.includes("html") ? htmlText(raw) : raw.replace(/\s+/g, " ").trim();
  const chars = Math.max(1_000, Math.min(MAX_WEB_CHARS, Math.floor(maxChars)));
  return {
    url: url.toString(),
    contentType,
    content: content.slice(0, chars),
    truncated: content.length > chars,
  };
}


export function createStudioOperations(config: StudioConfig) {
  return {
    async listSessions(access: AccessDecision | undefined): Promise<StudioSessionSummary[]> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const rows = await config.sessionStore.list(authorized.tenantId);
      return rows.map(toSummary);
    },

    async getSession(
      access: AccessDecision | undefined,
      id: string,
    ): Promise<StudioSessionView> {
      const authorized = requireTenantScope(access, "dashboard:read");
      const row = await config.sessionStore.get(authorized.tenantId, id);
      if (!row) throw new ConsoleDomainError("session_not_found", 404, "Studio session not found");
      return toSession(row);
    },

    async createSession(
      access: AccessDecision | undefined,
      input: { title?: unknown; model?: unknown; systemPrompt?: unknown },
    ): Promise<StudioSessionView> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const titleBounded = input.title === undefined ? undefined : boundedString(input.title, STUDIO_LIMIT_TITLE);
      if (input.title !== undefined && titleBounded === undefined)
        throw new ConsoleDomainError("invalid_title", 400, "title must be a string up to 200 characters");
      const title = titleBounded ?? "New session";

      const model = input.model === undefined ? "" : input.model;
      if (typeof model !== "string" || model.length > STUDIO_LIMIT_MODEL)
        throw new ConsoleDomainError("invalid_model", 400, "model must be a string up to 200 characters");
      const systemPrompt = input.systemPrompt === undefined ? "" : input.systemPrompt;
      if (typeof systemPrompt !== "string" || systemPrompt.length > STUDIO_LIMIT_SYSTEM_PROMPT)
        throw new ConsoleDomainError(
          "invalid_system_prompt",
          400,
          "systemPrompt must be a string up to 32000 characters",
        );
      // Bounded store: evict oldest-first past the per-tenant cap so create
      // never fails on a full shelf and never grows without bound.
      const ids = await config.sessionStore.listIdsOldestFirst(authorized.tenantId);
      const overflow = ids.length - STUDIO_MAX_SESSIONS_PER_TENANT + 1;
      for (let index = 0; index < overflow; index += 1) {
        const evict = ids[index];
        if (evict !== undefined) await config.sessionStore.delete(authorized.tenantId, evict);
      }
      const now = new Date();
      const row: StudioSessionRow = {
        id: randomUUID(),
        tenantId: authorized.tenantId,
        title,
        model,
        systemPrompt,
        messagesJson: [],
        mediaJson: [],
        createdAt: now,
        updatedAt: now,
      };
      await config.sessionStore.create(row);
      await config.auditSink?.record({
        access: authorized,
        action: "studio.session.created",
        target: row.id,
      });
      return toSession(row);
    },
    async webFetch(access: AccessDecision | undefined, url: unknown, maxChars: unknown): Promise<unknown> {
      const authorized = requireTenantScope(access, "dashboard:read");
      if (!config.webFetch) throw new ConsoleDomainError("web_tools_unavailable", 503, "web tools are unavailable");
      const limit = typeof maxChars === "number" && Number.isFinite(maxChars) ? maxChars : MAX_WEB_CHARS;
      return studioWebFetch(config.webFetch(authorized.tenantId), url, limit);
    },

    async patchSession(
      access: AccessDecision | undefined,
      id: string,
      input: {
        title?: unknown;
        model?: unknown;
        systemPrompt?: unknown;
        messages?: unknown;
        media?: unknown;
      },
    ): Promise<StudioSessionView> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const titleBounded = input.title === undefined ? undefined : boundedString(input.title, STUDIO_LIMIT_TITLE);
      if (input.title !== undefined && titleBounded === undefined)
        throw new ConsoleDomainError("invalid_title", 400, "title must be a string up to 200 characters");
      const modelBounded = input.model === undefined ? undefined : boundedString(input.model, STUDIO_LIMIT_MODEL);
      if (input.model !== undefined && modelBounded === undefined)
        throw new ConsoleDomainError("invalid_model", 400, "model must be a string up to 200 characters");
      const systemBounded =
        input.systemPrompt === undefined ? undefined : boundedString(input.systemPrompt, STUDIO_LIMIT_SYSTEM_PROMPT);
      if (input.systemPrompt !== undefined && systemBounded === undefined)
        throw new ConsoleDomainError(
          "invalid_system_prompt",
          400,
          "systemPrompt must be a string up to 32000 characters",
        );
      let messagesJson: unknown;
      if (input.messages !== undefined) {
        const messages = normalizeStudioMessages(input.messages);
        if (messages === null)
          throw new ConsoleDomainError("invalid_messages", 400, "messages must be an array of {role, content} entries");
        messagesJson = messages;
      }
      let mediaJson: unknown;
      if (input.media !== undefined) {
        const media = normalizeStudioMedia(input.media);
        if (media === null)
          throw new ConsoleDomainError("invalid_media", 400, "media must be an array of image results");
        mediaJson = media;
      }
      const updated = await config.sessionStore.update(authorized.tenantId, id, {
        ...(titleBounded === undefined ? {} : { title: titleBounded }),
        ...(modelBounded === undefined ? {} : { model: modelBounded }),
        ...(systemBounded === undefined ? {} : { systemPrompt: systemBounded }),
        ...(messagesJson === undefined ? {} : { messagesJson }),
        ...(mediaJson === undefined ? {} : { mediaJson }),
        updatedAt: new Date(),
      });
      if (!updated) throw new ConsoleDomainError("session_not_found", 404, "Studio session not found");
      await config.auditSink?.record({
        access: authorized,
        action: "studio.session.updated",
        target: id,
      });
      return toSession(updated);
    },

    async deleteSession(access: AccessDecision | undefined, id: string): Promise<void> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const deleted = await config.sessionStore.delete(authorized.tenantId, id);
      if (!deleted) throw new ConsoleDomainError("session_not_found", 404, "Studio session not found");
      await config.auditSink?.record({
        access: authorized,
        action: "studio.session.deleted",
        target: id,
      });
    },

    async ensureStudioKey(
      access: AccessDecision | undefined,
    ): Promise<{ key: string; keyId: string; prefix: string }> {
      const authorized = requireTenantScope(access, "dashboard:write");
      const keys = await config.keyStore.list(authorized.tenantId);
      const defaultKey = keys.find(
        (key) => key.label === DEFAULT_API_KEY_LABEL && key.revokedAt === undefined,
      );
      if (!defaultKey) {
        throw new ConsoleDomainError(
          "default_key_missing",
          409,
          "the default gateway API key is missing; complete console setup to create it",
        );
      }
      if (!defaultKey.keyEncrypted) {
        throw new ConsoleDomainError(
          "default_key_unrecoverable",
          409,
          "the default gateway API key has no recoverable secret; re-run console setup",
        );
      }
      return {
        key: decryptCredentialToString(defaultKey.keyEncrypted),
        keyId: defaultKey.id,
        prefix: defaultKey.keyPrefix ?? "",
      };
    },
  };
}

export function createStudioRoutes(config: StudioConfig): Elysia {
  const operations = createStudioOperations(config);
  return new Elysia({ prefix: "/studio" })
    .get("/sessions", async ({ request, set }) => {
      try {
        return { items: await operations.listSessions(config.accessResolver(request)) };
      } catch (error) {
        return errorResponse(error, set, "Studio operation failed");
      }
    })
    .get("/sessions/:id", async ({ request, params, set }) => {
      try {
        return await operations.getSession(config.accessResolver(request), params.id);
      } catch (error) {
        return errorResponse(error, set, "Studio operation failed");
      }
    })
    .post("/sessions", async ({ request, body, set }) => {
      try {
        set.status = 201;
        const input = isRecord(body) ? body : {};
        return await operations.createSession(config.accessResolver(request), {
          title: input["title"],
          model: input["model"],
          systemPrompt: input["systemPrompt"],
        });
      } catch (error) {
        return errorResponse(error, set, "Studio operation failed");
      }
    })
    .patch("/sessions/:id", async ({ request, params, body, set }) => {
      try {
        const input = isRecord(body) ? body : {};
        return await operations.patchSession(config.accessResolver(request), params.id, {
          title: input["title"],
          model: input["model"],
          systemPrompt: input["systemPrompt"],
          messages: input["messages"],
          media: input["media"],
        });
      } catch (error) {
        return errorResponse(error, set, "Studio operation failed");
      }
    })
    .delete("/sessions/:id", async ({ request, params, set }) => {
      try {
        await operations.deleteSession(config.accessResolver(request), params.id);
        return { success: true };
      } catch (error) {
        return errorResponse(error, set, "Studio operation failed");
      }
    })
    .post("/web-fetch", async ({ request, body, set }) => {
      try {
        const input = isRecord(body) ? body : {};
        return await operations.webFetch(config.accessResolver(request), input["url"], input["maxChars"]);
      } catch (error) {
        return errorResponse(error, set, "Studio web fetch failed");
      }
    })
    .post("/key", async ({ request, set }) => {
      try {
        return await operations.ensureStudioKey(config.accessResolver(request));
      } catch (error) {
        return errorResponse(error, set, "Studio operation failed");
      }
    }) as unknown as Elysia;
}

