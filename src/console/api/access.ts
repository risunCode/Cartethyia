/**
 * Access rules API — proxy/console ACLs with IP + CIDR entries (REQ-15, design §5.8).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { getAccessRules, setAccessRule, validateAccessEntry, type AccessScope } from "../db/repos/access";
import { isOneOf } from "../../shared/guards";

const ACCESS_SCOPES: AccessScope[] = ["proxy", "console"];

export const accessRoutes = new Elysia({ prefix: "/console/api/access" })
  .get("/", () => getAccessRules())
  .post("/:scope", ({ params, body, set }) => {
    if (!isOneOf(params.scope, ACCESS_SCOPES)) {
      set.status = 400;
      return consoleError("invalid_request", "scope must be 'proxy' or 'console'");
    }
    const input = (body ?? {}) as { mode?: string; entries?: unknown };
    if (input.mode !== "open" && input.mode !== "allowlist" && input.mode !== "denylist") {
      set.status = 400;
      return consoleError("invalid_request", "mode must be 'open', 'allowlist', or 'denylist'");
    }
    const entries = Array.isArray(input.entries) ? input.entries : [];
    if (!entries.every((e): e is string => typeof e === "string")) {
      set.status = 400;
      return consoleError("invalid_request", "entries must be an array of strings");
    }
    if (input.mode !== "open") {
      for (const entry of entries) {
        const error = validateAccessEntry(entry);
        if (error) {
          set.status = 400;
          return consoleError("invalid_request", `invalid entry "${entry}": ${error}`);
        }
      }
    }
    const rule = setAccessRule(params.scope, input.mode, entries);
    addAuditEvent("access.update", { scope: params.scope, mode: input.mode, entryCount: entries.length });
    return rule;
  });
