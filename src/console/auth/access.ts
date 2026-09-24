import type { AccessDecision } from "../../security/access-control";

/** Resolves the authenticated console request to a tenant-scoped decision. */
export type ConsoleAccessResolver = (request: Request) => AccessDecision | undefined;
