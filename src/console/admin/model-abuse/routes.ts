import { Elysia, t } from "elysia";
import type { ModelAbuseBan } from "../../../security/model-abuse";
import { ConsoleDomainError, errorResponse, requireGlobalAdmin } from "../../shared/errors";
import type { ModelAbuseRoutesConfig } from "./contracts";

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
