import { Elysia, t } from "elysia";
import { isProviderId } from "../../routing/providerMeta";
import { tokenKeeper } from "../../tokenkeeper";
import { TokenKeeperError, type OAuthProviderId } from "../../tokenkeeper/types";
import { consoleError, type ConsoleErrorCode } from "../errors";

type ConsoleErrorResponse = { error: { code: ConsoleErrorCode; message: string } };

function oauthProvider(value: string): OAuthProviderId | null {
  if (value === "openai-codex" || value === "anthropic-oauth" || value === "cline" || value === "grok-cli" || value === "google-antigravity") return value;
  return null;
}

function handleTokenKeeperError(error: unknown, set: { status?: number | string }): ConsoleErrorResponse {
  if (error instanceof TokenKeeperError) {
    set.status = error.status;
    const code: ConsoleErrorCode = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status >= 500 ? "internal" : "invalid_request";
    return consoleError(code, error.message);
  }
  set.status = 500;
  return consoleError("internal", "OAuth operation failed");
}

export const oauthRoutes = new Elysia({ prefix: "/console/api" })
  .post("/providers/:id/oauth/login", async ({ params, body, set }) => {
    if (!isProviderId(params.id)) {
      set.status = 404;
      return consoleError("not_found", "unknown provider");
    }
    const provider = oauthProvider(params.id);
    if (!provider) {
      set.status = 400;
      return consoleError("invalid_request", "provider does not support OAuth login");
    }
    try {
      return await tokenKeeper.startLogin(provider, body.name);
    } catch (error) {
      return handleTokenKeeperError(error, set);
    }
  }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 120 }) }) })
  .get("/oauth/login/:sessionId", ({ params, set }) => {
    const status = tokenKeeper.getLoginStatus(params.sessionId);
    if (!status) {
      set.status = 404;
      return consoleError("not_found", "OAuth login session not found");
    }
    return status;
  })
  .post("/oauth/login/:sessionId/complete", async ({ params, body, set }) => {
    try {
      return await tokenKeeper.completeLogin(params.sessionId, body.value);
    } catch (error) {
      return handleTokenKeeperError(error, set);
    }
  }, { body: t.Object({ value: t.String({ minLength: 1, maxLength: 8_000 }) }) })
  .post("/oauth/login/:sessionId/cancel", ({ params }) => {
    tokenKeeper.cancelLogin(params.sessionId);
    return { ok: true };
  });
