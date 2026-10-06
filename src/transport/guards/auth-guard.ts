// API-key authentication guard for `/v1/*`: token resolution, scope check,
// client-router denylist, and the model-abuse ban gate.
import { Elysia } from "elysia";
import { GatewayError } from "../../protocol/gateway-error";
import type { ProxyRequestStateStore } from "../request/state";
import { fastPathname } from "../../lib/pathname";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { requestToken, resolveApiKeyAuthorization } from "../../security/api-key-auth";
import {
  deniedClientRouter,
  detectClientRouter,
} from "../../security/client-router-fingerprint";
import { createAccessDecision } from "../../security/access-control";
import { modelAbuseBannedError, type ModelStrikeService } from "../../security/model-abuse";

/**
 * Stateless Elysia `beforeHandle` gateway check: API-key authentication,
 * wired into the middleware chain in `app.ts`.
 */
export function createApiKeyAuthenticationMiddleware(deps: {
  readonly db: CartethyiaDatabase;
  readonly stateStore: ProxyRequestStateStore;
  /**
   * Model-abuse ban gate. A banned IP or key is refused here, before the
   * canonical parse and route preparation, and before `state.authorization` is
   * assigned — so a banned caller's attempts produce no telemetry row and no
   * console error, which is exactly the noise this layer exists to stop.
   */
  readonly modelStrikes?: Pick<ModelStrikeService, "check">;
}): Elysia {
  // Single policy for every `/v1/*` gateway route: authenticated, scoped to
  // `routing:invoke`, and tenant-bound (the snapshot's tenant is the only
  // tenant this key may address). The check is inline rather than routed
  // through a per-route policy table: Elysia's router already owns which
  // paths exist, so a per-route table only added a second place to keep in
  // sync.
  return new Elysia()
    .beforeHandle(async ({ request }) => {
      const pathname = fastPathname(request.url);
      if (!pathname.startsWith("/v1/")) return;
      const token = requestToken(request.headers);
      const authorization = await resolveApiKeyAuthorization(deps.db, token);
      if (!authorization)
        throw new GatewayError("invalid_request", 401, "invalid or revoked API key");
      const decision = createAccessDecision({
        id: authorization.id,
        tenantId: authorization.tenantId,
        scopes: authorization.scopes,
      });
      if (!decision.scopes.includes("routing:invoke"))
        throw new GatewayError("invalid_request", 403, "API key lacks routing:invoke scope");
      // A key may refuse a downstream router it has been resold to. This is a
      // policy check on the resolved key, so it belongs with the other
      // authorization decisions rather than in routing: the request is refused
      // before a route is planned or an upstream is touched.
      const denied = deniedClientRouter(
        authorization.snapshot.client_router_denylist,
        detectClientRouter({ headers: request.headers }),
      );
      if (denied !== null)
        throw new GatewayError(
          "client_router_denied",
          403,
          "No API invocation access for this client.",
          { reason: "client_router_denied", clientRouter: denied },
        );
      // Abuse ban: refuse before parse/prepare and before authorization is
      // recorded, so a banned caller cannot keep producing failed rows. The ban
        // is keyed on the client address, not the key: one key can be shared by
        // every recipient of a share link, so refusing the key would punish
        // callers that did nothing.
      if (deps.modelStrikes) {
        const state = deps.stateStore.get(request);
        const ip = state?.clientIdentity?.address;
        if (ip !== undefined) {
          const banned = await deps.modelStrikes.check({ ip }).catch(() => false);
          if (banned) throw modelAbuseBannedError();
        }
      }
      deps.stateStore.require(request).authorization = authorization;
    })
    .as("plugin");
}
