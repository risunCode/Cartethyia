import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { createShareLink } from "../db/repos/share-links";

export const shareRoutes = new Elysia({ prefix: "/console/api" })
  .post("/keys/:id/share", ({ params, request, set }) => {
    const created = createShareLink(params.id);
    if (!created) {
      set.status = 404;
      return consoleError("not_found", "active key not found");
    }
    const url = new URL(`/share/${created.token}`, request.url).toString();
    addAuditEvent("key.share_created", { id: created.key.id, name: created.key.name });
    return { url, token: created.token, keyId: created.key.id };
  });
