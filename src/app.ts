/** App assembly — request logging, public routes, and friendly error boundaries. */

import { Elysia, redirect } from "elysia";
import { invalidRequestError, unexpectedClientError, unknownRouteError } from "./http/errors";
import { requestLogger } from "./http/middleware";
import { createCorsMiddleware } from "./http/cors";
import { config } from "./config";
import { healthRoute, modelsRoute } from "./routes/status";
import { chatRoute } from "./routes/chat";
import { messagesRoute } from "./routes/messages";
import { countTokensRoute } from "./routes/count-tokens";
import { responsesRoute } from "./routes/responses";
import { responsesCompactRoute } from "./routes/responses-compact";
import { consoleApiRoutes } from "./console/api/routes";
import { consoleWebRoutes } from "./console/web";

export const app = new Elysia({
  serve: { maxRequestBodySize: 10 * 1024 * 1024 }, // 10MB (L4)
})
  .onError({ as: "global" }, ({ code, path, set, error }) => {
    if (code === "VALIDATION") {
      set.status = 422;
      return invalidRequestError(path);
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return unknownRouteError(path);
    }
    // Previously silent — the client got a generic 500 pointing at "the
    // server logs" that never actually contained anything. Log the real
    // error so that promise isn't a lie.
    console.error(`[unhandled] ${path}:`, error);
    set.status = 500;
    return unexpectedClientError(path);
  })
  .get("/", () => redirect("/console/"))
  .use(createCorsMiddleware(config.corsAllowedOrigins))
  .use(requestLogger)
  .use(consoleApiRoutes)
  .use(consoleWebRoutes)
  .use(healthRoute)
  .use(modelsRoute)
  .use(chatRoute)
  .use(messagesRoute)
  .use(countTokensRoute)
  .use(responsesRoute)
  .use(responsesCompactRoute);
