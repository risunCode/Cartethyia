/**
 * TypeBox request body schemas — real runtime validation at the Elysia route
 * boundary (`body: <schema>`), not a hand-rolled field check. Nested content
 * blocks (text/image/tool_use/tool_result, tool_calls, function_call items)
 * are typed loosely with `t.Unknown()` where the shape is a deep union
 * already re-validated structurally by `translate/concerns/normalize.ts`
 * (e.g. every block is switched on `.type` there) — duplicating the full
 * discriminated-union schema here would just be the same check twice.
 */

import { t } from "elysia";

export const ChatRequestSchema = t.Object(
  {
    model: t.String(),
    messages: t.Array(t.Unknown(), { minItems: 1 }),
  },
  { additionalProperties: true }
);

export const MessagesRequestSchema = t.Object(
  {
    model: t.String(),
    max_tokens: t.Number(),
    messages: t.Array(t.Unknown(), { minItems: 1 }),
  },
  { additionalProperties: true }
);

export const ResponsesRequestSchema = t.Object(
  {
    model: t.String(),
    input: t.Union([t.String(), t.Array(t.Unknown())]),
  },
  { additionalProperties: true }
);
