/**
 * Native (non-canonical) service routes.
 *
 * The canonical surface pipeline exists for chat-shaped wires: a caller's body
 * is parsed into `CanonicalRequest`, dispatched, and the upstream stream is
 * re-encoded into the caller's surface. Some upstreams expose a protocol that
 * is not chat-shaped at all — the System One decision API takes
 * `{model, state, questions}` and answers `{answers}`, with no messages, tools,
 * or streaming. Forcing that through the canonical model would add fields and
 * events used by exactly one protocol, so it gets its own route instead: the
 * body is opaque (neither parsed nor projected), but routing, admission, retry,
 * accounting, and telemetry still run through the shared attempt loop.
 *
 * This table is the single declaration of those routes. The ingress body
 * policy reads {@link NATIVE_SERVICE_PATHS} to read their bodies and to keep
 * them out of the canonical parse stage; `app.ts` mounts one handler per entry.
 * Adding the next native protocol is one row here plus one adapter capability.
 */
import type { ServiceKind } from "../canonical-model";

/** One native service: the path it is served at and the kind its models carry. */
export interface NativeServiceRoute {
  readonly serviceKind: Exclude<ServiceKind, "llm">;
  readonly path: string;
}

export const NATIVE_SERVICES: readonly NativeServiceRoute[] = [
  { serviceKind: "systemone", path: "/v1/systemone" },
  { serviceKind: "websearch", path: "/v1/search" },
] as const;

/** Paths served by a native service route, for the ingress body/canonical skip. */
export const NATIVE_SERVICE_PATHS: readonly string[] = NATIVE_SERVICES.map(
  (service) => service.path,
);

/** Whether `path` is served by a native service route. */
export function isNativeServicePath(path: string | undefined): boolean {
  return path !== undefined && NATIVE_SERVICE_PATHS.includes(path);
}

/** The route path serving `serviceKind`, when one is declared. */
export function nativeServicePathFor(serviceKind: string): string | undefined {
  return NATIVE_SERVICES.find((service) => service.serviceKind === serviceKind)?.path;
}
