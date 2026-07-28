/** App assembly — request logging, public routes, and friendly error boundaries. */

import { Elysia } from "elysia";
import { invalidRequestError, unexpectedClientError } from "./http/errors";
import { requestLogger } from "./http/middleware";
import { healthRoute, modelsRoute } from "./routes/status";
import { chatRoute } from "./routes/chat";
import { messagesRoute } from "./routes/messages";
import { responsesRoute } from "./routes/responses";

export const app = new Elysia()
  .onError({ as: "global" }, ({ code, path, set }) => {
    if (code === "VALIDATION") {
      set.status = 422;
      return invalidRequestError(path);
    }
    set.status = 500;
    return unexpectedClientError(path);
  })
  .use(requestLogger)
  .use(healthRoute)
  .use(modelsRoute)
  .use(chatRoute)
  .use(messagesRoute)
  .use(responsesRoute);
