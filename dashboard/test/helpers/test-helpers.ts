/**
 * Shared dashboard test scaffolding.
 *
 * Not imported by application code — only by `*.test.ts`/`*.test.tsx` in this
 * workspace.
 */

/** Builds a JSON `Response` for fetch stubs. */
export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
