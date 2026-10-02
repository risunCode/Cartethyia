/**
 * Canonical usage breakdown dimensions: the `by-<dimension>` paths the usage
 * endpoint registers and the operations validator accepts.
 *
 * One runtime tuple, because three layers read it: the route table registers
 * one path per member, the validator rejects anything outside it, and the
 * dashboard offers one breakdown tab per member (kept in sync by hand).
 *
 * This module is intentionally free of Elysia / node:crypto so the dashboard
 * can re-export the tuple as a value. The dashboard previously reached it
 * through `./contracts`, which imports Elysia and — through
 * `console/shared/errors` → `protocol/primitives` → `security/outbound-headers`
 * — `node:crypto`, so the browser bundle externalized a Node builtin and
 * carried a slice of the backend graph for one string list.
 */
export const USAGE_DIMENSIONS = ["model", "provider", "key", "client", "client_ip"] as const;

/** One usage breakdown dimension. */
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];
