// Console surface for model-abuse bans: list active bans and lift one.
//
// The strike layer (security/model-abuse.ts) bans a client address after
// repeated invalid-model requests. A ban lapses on its own after its TTL, and
// this is the escape hatch for lifting one early — a false positive (a shared
// NAT, a client that genuinely mistyped) must be fixable without SQL. It is a
// platform-admin surface: a ban is a security decision and the identity values
// are cross-tenant.
import type { AccessDecision } from "../../../security/access-control";
import type { ModelStrikeService } from "../../../security/model-abuse";

export interface ModelAbuseRoutesConfig {
  readonly strikes: Pick<ModelStrikeService, "listBans" | "unban">;
  readonly accessResolver: (request: Request) => AccessDecision | undefined;
}

