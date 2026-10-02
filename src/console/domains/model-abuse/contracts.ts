// Console surface for model-abuse bans: list active bans and lift one.
//
// The strike layer (security/model-abuse.ts) bans a client address after
// repeated invalid-model requests. A ban lapses on its own after its TTL, and
// this is the escape hatch for lifting one early — a false positive (a shared
// NAT, a client that genuinely mistyped) must be fixable without SQL. It is a
// platform-admin surface: a ban is a security decision and the identity values
// are cross-tenant.
import { Elysia, t } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import type { ModelAbuseBan, ModelStrikeService } from "../../../security/model-abuse";
import { ConsoleDomainError, errorResponse, requireGlobalAdmin } from "../../shared/errors";

export interface ModelAbuseRoutesConfig {
  readonly strikes: Pick<ModelStrikeService, "listBans" | "unban">;
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
}

const unbanBody = t.Object({
  identity: t.String({ minLength: 1 }),
});

export function createModelAbuseRoutes(config: ModelAbuseRoutesConfig): Elysia {
  return new Elysia()
    .get("/model-bans", async ({ request, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const bans: readonly ModelAbuseBan[] = await config.strikes.listBans();
        return { bans };
      } catch (e) {
        return errorResponse(e, set, "Model ban read failed");
      }
    })
    .delete("/model-bans", { body: unbanBody }, async ({ request, body, set }) => {
      try {
        requireGlobalAdmin(config.accessResolver(request));
        const removed = await config.strikes.unban(body.identity);
        if (!removed) throw new ConsoleDomainError("ban_not_found", 404, "No such ban");
        return { success: true };
      } catch (e) {
        return errorResponse(e, set, "Model unban failed");
      }
    }) as unknown as Elysia;
}
