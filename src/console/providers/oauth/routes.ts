import { providerAccounts, providerOauthStates } from "../../../persistence/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { encryptCredential, hashSecret } from "../../../security/crypto";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import type { OAuthExchangeResult, OAuthLoginClient } from "../../../providers/authentication/oauth-flow-store";
import type { OAuthDevicePollResponse } from "../catalog/contracts";
import { providerJwtVerification, type ProviderRegistry } from "../../../providers/provider-registry";
import { browserAuthorizeRedirectUri } from "../../../config";
import { log } from "../../../observability/logger";
import { GatewayError } from "../../../transport/gateway-error";
import { Elysia, t } from "elysia";
import { ConsoleDomainError, errorResponse, requireScope } from "../../shared/errors";
import { generateOAuthState, generatePkcePair } from "../../../providers/authentication/oauth-flow-store";
import type { OAuthFlowStore } from "../../../providers/authentication/oauth-flow-store";
import type { OAuthCallbackListener } from "./callback-listener";
import { validateIssuedAccessToken } from "../../../providers/authentication/jwt-validator";
import { inlineScriptContentSecurityPolicy } from "../../../security/outbound-headers";
import type { AccessDecision } from "../../../security/access-control";
import { isUniqueViolation } from "../../../persistence/postgres";
import type { ConsoleAccessResolver } from "../../auth/access";
/**
 * The identity a repeated OAuth login is matched on.
 *
 * The refresh token cannot be that identity: a fresh login mints a new one, so
 * keying on it let the same account be added twice — the duplicate unique index
 * only caught a replay of the *exact* credential. The label is the account
 * identity the provider itself reports (an email or org name), which is stable
 * across logins, so it is what a re-login replaces.
 *
 * A provider that reports no label falls back to the refresh-token fingerprint,
 * which is the old behaviour and still catches an exact replay. Renaming an
 * account in the console changes the stored label, so a later login is treated
 * as a new account rather than silently overwriting the rename — the same
 * tradeoff the unique index has always had, now stated where it is decided.
 */
function oauthIdentityFingerprint(input: { readonly label: string } & OAuthExchangeResult): string {
  return hashSecret(input.label.trim().length > 0 ? input.label.trim() : input.refresh);
}

export class DrizzleOAuthAccountStore implements OAuthAccountStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async persistAccount(
    tenantId: string | null,
    providerId: string,
    input: { readonly label: string } & OAuthExchangeResult,
  ): Promise<PersistedOAuthAccount> {
    const credentialFingerprint = oauthIdentityFingerprint(input);
    const sameAccount = and(
      eq(providerAccounts.providerId, providerId),
      // The identity index coalesces a null tenant to a sentinel, so "same
      // tenant" here means both null or both equal.
      tenantId === null
        ? isNull(providerAccounts.tenantId)
        : eq(providerAccounts.tenantId, tenantId),
      eq(providerAccounts.credentialFingerprint, credentialFingerprint),
    );
    const credentialCiphertext = encryptCredential(input.access);
    const refreshCiphertext = encryptCredential(input.refresh);
    const clientSecretCiphertext =
      input.client_secret === undefined ? undefined : encryptCredential(input.client_secret);
    try {
      return await this.db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: providerAccounts.id })
          .from(providerAccounts)
          .where(sameAccount)
          .limit(1);
        const existingId = existing[0]?.id;
        if (existingId !== undefined) {
          // A re-login replaces the account it belongs to rather than adding a
          // second row: the same email is the same account, and the newer
          // tokens are the ones that work. The health state is reset with them,
          // because a fresh credential makes the old rejection — the
          // `Disabled` / `Re-login required` row an operator was looking at —
          // meaningless by definition.
          await tx
            .update(providerAccounts)
            .set({
              // A re-login carries a freshly validated identity, so it adopts
              // the learned label — but never over an operator's custom rename.
              // The CASE keeps the read and the write in one statement, so a
              // concurrent rename cannot lose to the login.
              label: sql`CASE WHEN lower(trim(${providerAccounts.label})) = lower(trim(${providerAccounts.providerId})) THEN ${input.label} ELSE ${providerAccounts.label} END`,
              credentialCiphertext,
              credentialKind: "oauth",
              status: "active",
              consecutiveFailures: 0,
              cooldownUntil: null,
              modelCooldowns: {},
              lastError: null,
              lastErrorCategory: null,
              lastErrorAt: null,
              lastRecoveredAt: null,
              // A fresh login supplies a refresh token, so the account returns
              // to normal OAuth refresh handling — a static-token flag set on
              // the previous (refresh-less) credential no longer applies.
              staticToken: false,
              // Only what this login reported: a flow that learned no profile or
              // region leaves the stored configuration alone rather than blanking it.
              ...(input.auth_state === undefined ? {} : { authState: input.auth_state }),
            })
            .where(eq(providerAccounts.id, existingId));
          await tx
            .update(providerOauthStates)
            .set({
              refreshCiphertext,
              expiresAt: input.expiresAt,
              ...(clientSecretCiphertext === undefined ? {} : { clientSecretCiphertext }),
            })
            .where(eq(providerOauthStates.providerAccountId, existingId));
          return { accountId: existingId };
        }
        const rows = await tx
          .insert(providerAccounts)
          .values({
            providerId,
            tenantId,
            label: input.label,
            credentialKind: "oauth",
            credentialCiphertext,
            credentialFingerprint,
            status: "active",
            ...(input.auth_state === undefined ? {} : { authState: input.auth_state }),
          })
          .returning({ id: providerAccounts.id });
        const row = rows[0];
        if (!row) throw new Error("failed to persist OAuth account");
        await tx.insert(providerOauthStates).values({
          providerAccountId: row.id,
          refreshCiphertext,
          expiresAt: input.expiresAt,
          ...(clientSecretCiphertext === undefined ? {} : { clientSecretCiphertext }),
        });
        return { accountId: row.id };
      });
    } catch (error) {
      // Still reachable: two logins for the same identity racing each other
      // both read "no row" and both insert, and the identity index rejects the
      // second. A retry by the operator replaces rather than duplicates.
      if (isUniqueViolation(error)) {
        throw new ConsoleDomainError(
          "provider_account_duplicate",
          409,
          "A provider account with this credential already exists",
        );
      }
      throw error;
    }
  }
}

/**
 * Console OAuth login domain: authorize-URL initiation, callback exchange,
 * and device-code start/poll — driven by whichever `OAuthLoginClient` is
 * registered for a given provider id.
 *
 * > **Koreksi.** An earlier comment here read "Cartethyia hosts the callback
 * > itself (it's a server process, not a local CLI), so there is no
 * > loopback-listener/port-selection problem." That was wrong, and it is the
 * > premise that produced the bug. The redirect URIs these clients advertise
 * > are loopback (`localhost:1455`, `127.0.0.1:54549`, …), which name the
 * > machine the *operator's browser* is on — not this process. Advertising one
 * > without binding the port leaves the code in the browser's address bar, so
 * > every browser login needed the redirect pasted back by hand. The gateway
 * > is a server process, but it is not *the* server the redirect arrives at;
 * > `callback-listener.ts` is what makes those the same endpoint.
 */
export interface PersistedOAuthAccount {
  readonly accountId: string;
}

export interface OAuthAccountStore {
  persistAccount(
    tenantId: string | null,
    providerId: string,
    input: { readonly label: string } & OAuthExchangeResult,
  ): Promise<PersistedOAuthAccount>;
}

export interface OAuthLoginConfig {
  readonly providerRegistry: ProviderRegistry;
  readonly oauthFlowStore: OAuthFlowStore;
  readonly accountStore: OAuthAccountStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /**
   * Binds the loopback port a browser redirect names, so the callback delivers
   * itself instead of waiting for the operator to paste the URL back.
   */
  readonly callbackListener: OAuthCallbackListener;
}

async function requireClient(
  registry: ProviderRegistry,
  providerId: string,
): Promise<OAuthLoginClient> {
  const client = await registry.resolveLoginClient(providerId);
  if (!client)
    throw new ConsoleDomainError(
      "oauth_not_supported",
      404,
      `Provider ${providerId} has no OAuth login client registered`,
      { providerId },
    );
  return client;
}

/** The result of exchanging one authorization code, as the caller should report it. */
export interface OAuthCompleteOutcome {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Consumes the pending flow, exchanges the code, and persists the account.
 *
 * Shared by the hosted console callback and the loopback listener so both
 * report the same failures: the listener renders `message` in the browser, and
 * the hosted route turns it into a JSON or HTML page. Upstream token-endpoint
 * bodies can echo credentials, so the message stays generic unless the error
 * came from our own boundary (see {@link publicExchangeFailure}).
 */
export async function completeLogin(
  config: OAuthLoginConfig,
  providerId: string,
  code: string,
  state: string,
): Promise<OAuthCompleteOutcome> {
  // An empty `state` means the authorization server does not echo one
  // (OpenRouter omits it from the callback entirely); correlate by provider in
  // that case, and by state otherwise so the stronger check stays in force
  // wherever the server supports it.
  const flow = state
    ? await config.oauthFlowStore.consumePending(state)
    : await config.oauthFlowStore.consumePendingByProvider(providerId);
  if (!flow || flow.providerId !== providerId) {
    return { ok: false, message: "unknown or expired state" };
  }
  // The flow is spent, so its listener registration has nothing left to wait
  // for; releasing it here keeps a manual paste from leaving the port bound.
  // Stateless callbacks arrive with `""`, which matches no filed state —
  // release by provider so the OpenRouter port does not linger until TTL.
  if (state.length > 0) config.callbackListener.release(flow.redirectUri, state);
  else config.callbackListener.releaseProvider(flow.redirectUri, providerId);
  const client = await requireClient(config.providerRegistry, providerId);
  if (!client.exchangeCode) {
    return { ok: false, message: "provider does not support browser authorization" };
  }
  try {
    const result = await client.exchangeCode(code, flow.codeVerifier, flow.redirectUri, state);
    const tokenCheck = await validateIssuedAccessToken(
      result.access,
      providerJwtVerification(providerId),
    );
    if (!tokenCheck.valid) {
      throw new ConsoleDomainError(
        "oauth_token_invalid",
        400,
        `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
        { providerId },
      );
    }
    await config.accountStore.persistAccount(flow.tenantId, providerId, {
      label: result.accountLabel ?? flow.accountLabel,
      ...result,
    });
    await config.snapshotInvalidator?.invalidate();
    return { ok: true, message: `${providerId} account connected. You may close this tab.` };
  } catch (error) {
    // Upstream token-endpoint bodies can echo credentials or sensitive
    // diagnostics — the browser gets a generic failure; the bounded detail
    // stays server-side in the console log.
    log.error(
      `[oauth] token exchange failed for ${providerId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error : undefined,
    );
    return { ok: false, message: publicExchangeFailure(error) };
  }
}

function successPage(providerId: string, wantsJson: boolean): Response {
  if (wantsJson) {
    return Response.json({
      providerId,
      message: `${providerId} account connected. You may close this tab.`,
    });
  }
  const closeScript = "window.close();";
  return new Response(
    `<!doctype html><html><body><p>${providerId} account connected. You may close this tab.</p><script>${closeScript}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": inlineScriptContentSecurityPolicy([closeScript]),
      },
    },
  );
}

/**
 * Message shown in the browser when a token exchange throws.
 *
 * `GatewayError.origin` marks which boundary produced the error, and its own
 * contract calls a non-upstream error "a safe public error". So a
 * `cartethyia`-origin message — authored by one of our integrations, already
 * sanitized — is shown as-is: without it, an actionable failure such as "MiMo
 * Desktop is running and holds its cookie store locked" reaches the operator
 * only through the server log, and the dialog says nothing they can act on.
 * Anything else (an upstream body, a network failure, an arbitrary throw) keeps
 * the generic wording, because an upstream response can echo credentials.
 */
function publicExchangeFailure(error: unknown): string {
  if (error instanceof GatewayError && error.origin === "cartethyia") return error.message;
  return "token exchange failed — check the console log for details";
}

function failurePage(message: string, wantsJson: boolean): Response {
  if (wantsJson) {
    return Response.json(
      { error: message, code: "oauth_callback_failed" },
      { status: 400 },
    );
  }
  const escapedMessage = message.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
  return new Response(
    `<!doctype html><html><body><p>OAuth login failed: ${escapedMessage}</p></body></html>`,
    {
      status: 400,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": inlineScriptContentSecurityPolicy([]),
      },
    },
  );
}

export function createOAuthLoginOperations(config: OAuthLoginConfig) {
  const operations = {
    async beginAuthorize(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
        parameters?: Readonly<Record<string, string>>,
      ): Promise<{ authorizeUrl: string; state: string }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (typeof client.buildAuthorizeUrl !== "function") {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            `Provider ${providerId} only supports device-code login — use "Login with device code" instead`,
            { providerId },
          );
        }
        if (typeof client.exchangeCode !== "function") {
          throw new ConsoleDomainError(
            "browser_code_not_supported",
            409,
            `Provider ${providerId} only supports device-code login — use "Login with device code" instead`,
            { providerId },
          );
        }
        const state = generateOAuthState();
        const { codeVerifier, codeChallenge } = generatePkcePair();
        // A client that names its own allowlisted redirect URI wins over the
        // gateway default: OpenAI registers exactly `http://localhost:1455/auth/callback`
        // for the Codex client and answers any other value with
        // `invalid_request` before consent, so the shared default cannot serve
        // every provider.
        const redirectUri = client.browserRedirectUri ?? browserAuthorizeRedirectUri();
        // Bind the redirect's loopback port before the flow is recorded. The
        // advertised URI names the operator's own machine, so a login that only
        // advertises it leaves the browser on a dead page and the code stranded
        // in the address bar. Binding first also means a port conflict throws
        // here — with no pending flow saved — rather than leaving a flow whose
        // callback can never arrive. A non-loopback redirect (a custom scheme, a
        // remote host) returns false and keeps the manual paste path.
        config.callbackListener.register(redirectUri, providerId, state);
        await config.oauthFlowStore.savePending(state, {
          providerId,
          codeVerifier,
          accountLabel,
          tenantId: a.tenantId,
          redirectUri,
          ...(parameters === undefined ? {} : { parameters }),
        });
        // Bind the redirect's loopback port before handing the URL out. The
        // advertised URI names the operator's own machine, so a login that only
        // advertises it leaves the browser on a dead page and the code stranded
        // in the address bar. Registering here is what makes the redirect
        // deliver itself; a non-loopback redirect (a custom scheme, a remote
        // host) returns false and keeps the manual path.
        return {
          authorizeUrl: client.buildAuthorizeUrl({
            state,
            codeChallenge,
            redirectUri,
            ...(parameters === undefined ? {} : { parameters }),
          }),
          state,
        };
      },
    async handleCallback(
        providerId: string,
        code: string,
        state: string,
        wantsJson = false,
      ): Promise<Response> {
        const outcome = await completeLogin(config, providerId, code, state);
        return outcome.ok ? successPage(providerId, wantsJson) : failurePage(outcome.message, wantsJson);
      },
    async handleCallbackError(
        providerId: string,
        state: string,
        wantsJson = false,
      ): Promise<Response> {
        const flow = await config.oauthFlowStore.consumePending(state);
        if (!flow || flow.providerId !== providerId)
          return failurePage("unknown or expired state", wantsJson);
        // A denial settles the flow too: free its port instead of holding it
        // until TTL.
        config.callbackListener.release(flow.redirectUri, state);
        return failurePage("authorization was denied by the provider", wantsJson);
      },
    async startDevice(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
        parameters?: Readonly<Record<string, string>>,
      ): Promise<{
        verificationUri: string;
        userCode: string;
        deviceAuthId: string;
        intervalSeconds: number;
        expiresInSeconds: number;
      }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.supportsDeviceCode || !client.startDeviceAuth)
          throw new ConsoleDomainError(
            "device_code_not_supported",
            409,
            `Provider ${providerId} does not support device-code login`,
            { providerId },
          );
        const started = await client.startDeviceAuth({
          providerId,
          tenantId: a.tenantId,
          accountLabel,
          ...(parameters === undefined ? {} : { parameters }),
        });
        const { providerState, ...publicStarted } = started;
        await config.oauthFlowStore.saveDevice(started.deviceAuthId, {
          providerId,
          accountLabel,
          tenantId: a.tenantId,
          ...(providerState === undefined ? {} : { providerState }),
          ...(parameters === undefined ? {} : { parameters }),
        });
        return publicStarted;
      },
    async pollDevice(
        access: AccessDecision | undefined,
        providerId: string,
        deviceAuthId: string,
      ): Promise<OAuthDevicePollResponse> {
        const a = requireScope(access, "dashboard:write");
        const correlation = await config.oauthFlowStore.getDevice(deviceAuthId);
        if (
          !correlation ||
          correlation.providerId !== providerId ||
          correlation.tenantId !== a.tenantId
        )
          throw new ConsoleDomainError("device_flow_unknown", 404, "Unknown or expired device-code flow", {
            deviceAuthId,
          });
        const client = await requireClient(config.providerRegistry, providerId);
        if (!client.pollDeviceAuth)
          throw new ConsoleDomainError(
            "device_code_not_supported",
            409,
            "Provider does not support device-code login",
          );
        const polled = await client.pollDeviceAuth(deviceAuthId, {
          providerId,
          tenantId: a.tenantId,
          accountLabel: correlation.accountLabel,
          ...(correlation.providerState === undefined
            ? {}
            : { providerState: correlation.providerState }),
          ...(correlation.parameters === undefined ? {} : { parameters: correlation.parameters }),
        });
        if (polled.status === "pending")
          return {
            status: "pending",
            ...(polled.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: polled.retryAfterSeconds }),
          };
        if (polled.status === "slow_down") {
          return {
            status: "slow_down",
            ...(polled.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: polled.retryAfterSeconds }),
          };
        }
        if (polled.status === "failed") {
          await config.oauthFlowStore.deleteDevice(deviceAuthId);
          return { status: "failed", reason: polled.reason };
        }
        const tokenCheck = await validateIssuedAccessToken(
          polled.result.access,
          providerJwtVerification(providerId),
        );
        if (!tokenCheck.valid) {
          await config.oauthFlowStore.deleteDevice(deviceAuthId);
          throw new ConsoleDomainError(
            "oauth_token_invalid",
            400,
            `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
            { providerId },
          );
        }
        // Delete only after persistAccount succeeds: a failure here (DB error)
        // must leave the device-flow state intact so the poller can retry
        // persisting the already-exchanged token instead of losing it and
        // forcing the operator through device authorization again.
        const persisted = await config.accountStore.persistAccount(
          correlation.tenantId,
          providerId,
          {
            label: polled.result.accountLabel ?? correlation.accountLabel,
            ...polled.result,
          },
        );
        await config.oauthFlowStore.deleteDevice(deviceAuthId);
        await config.snapshotInvalidator?.invalidate();
        return { status: "complete", accountId: persisted.accountId };
      },
    async importCredential(
        access: AccessDecision | undefined,
        providerId: string,
        accountLabel: string,
        credential: string,
        fields: Readonly<Record<string, string>>,
      ): Promise<{ accountId: string }> {
        const a = requireScope(access, "dashboard:write");
        const client = await requireClient(config.providerRegistry, providerId);
        if (typeof client.importCredential !== "function") {
          throw new ConsoleDomainError(
            "import_not_supported",
            409,
            `Provider ${providerId} does not accept an imported credential`,
            { providerId },
          );
        }
        // The client validates the material against the upstream before this
        // returns, so nothing that never worked reaches the account table.
        const result = await client.importCredential({ credential, fields });
        const tokenCheck = await validateIssuedAccessToken(
          result.access,
          providerJwtVerification(providerId),
        );
        if (!tokenCheck.valid) {
          throw new ConsoleDomainError(
            "oauth_token_invalid",
            400,
            `Provider ${providerId} returned an access token that failed validation (${tokenCheck.reason})`,
            { providerId },
          );
        }
        const persisted = await config.accountStore.persistAccount(a.tenantId, providerId, {
          label: result.accountLabel ?? accountLabel,
          ...result,
        });
        await config.snapshotInvalidator?.invalidate();
        return { accountId: persisted.accountId };
      },
  };
  return operations;
}

function oauthErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "OAuth login operation failed", {
    detailsPolicy: "always-include",
  });
}

const startBody = t.Optional(
  t.Object({
    accountLabel: t.Optional(t.String()),
    /**
     * Provider-specific start inputs the dashboard collected, such as the
     * organization URL or region for a device flow. Providers that need none
     * ignore the field.
     */
    parameters: t.Optional(t.Record(t.String(), t.String())),
  }),
);
const devicePollBody = t.Object({ deviceAuthId: t.String() });
const importBody = t.Object({
  /** The pasted credential material: a token, a key, or an exported auth blob. */
  credential: t.String(),
  /** Values for the fields the provider declared under `oauthFlows.importFields`. */
  fields: t.Optional(t.Record(t.String(), t.String())),
  accountLabel: t.Optional(t.String()),
});

export function createOAuthLoginRoutes(config: OAuthLoginConfig): Elysia {
  const factory = createOAuthLoginOperations(config);
  return new Elysia({ prefix: "/providers" })
    .post(
      "/:providerId/oauth/authorize",
      { body: startBody },
      async ({ request, params, body, set }) => {
        try {
          set.status = 201;
          return await factory.beginAuthorize(
            config.accessResolver(request),
            params.providerId,
            body?.accountLabel ?? params.providerId,
            body?.parameters,
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .get("/:providerId/oauth/callback", async ({ params, query, request }) => {
      const wantsJson = (request.headers.get("accept") ?? "").includes("application/json");
      const code = typeof query["code"] === "string" ? query["code"] : "";
      const state = typeof query["state"] === "string" ? query["state"] : "";
      const providerError = typeof query["error"] === "string" ? query["error"] : "";
      if (providerError && state)
        return factory.handleCallbackError(params.providerId, state, wantsJson);
      if (!code) return failurePage("missing code", wantsJson);
      // `state` is absent for authorization servers that do not echo it
      // (OpenRouter). The flow is then correlated by provider instead — one
      // browser login is in flight per provider at a time.
      return factory.handleCallback(params.providerId, code, state, wantsJson);
    })
    .post(
      "/:providerId/oauth/device/start",
      { body: startBody },
      async ({ request, params, body, set }) => {
        try {
          set.status = 201;
          return await factory.startDevice(
            config.accessResolver(request),
            params.providerId,
            body?.accountLabel ?? params.providerId,
            body?.parameters,
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .post(
      "/:providerId/oauth/device/poll",
      { body: devicePollBody },
      async ({ request, params, body, set }) => {
        try {
          return await factory.pollDevice(
            config.accessResolver(request),
            params.providerId,
            body.deviceAuthId,
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    )
    .post(
      "/:providerId/oauth/import",
      { body: importBody },
      async ({ request, params, body, set }) => {
        try {
          set.status = 201;
          return await factory.importCredential(
            config.accessResolver(request),
            params.providerId,
            body.accountLabel ?? params.providerId,
            body.credential,
            body.fields ?? {},
          );
        } catch (e) {
          return oauthErrorResponse(e, set);
        }
      },
    ) as unknown as Elysia;
}

