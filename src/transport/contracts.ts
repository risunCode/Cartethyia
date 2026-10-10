// Shared transport contracts: the types and the native route table that the
// ingress guard stage, the request pipeline, and dispatch all reference.
// Hoisted here (from `dispatch/native-services.ts` and the guard modules) so
// the former `middleware ↔ dispatch` import tangle is one-directional:
// dispatch may import the guard stage; the guard stage never imports dispatch.
import type { ServiceKind, CanonicalRequest } from "../protocol/canonical-model";
import type { ReadinessCheckResult } from "../persistence/readiness";

/**
 * A drain/shutdown source the readiness guard reads: whether the process is
 * draining, and why, so the termination notice can tell a stop from an update.
 * Hoisted here (out of the readiness guard) so the pipeline, the composition
 * root, and the runtime lifecycle all name one structural type instead of
 * re-declaring it per layer.
 */
export interface ShutdownDrainSource {
  isDraining(): boolean;
  /** Why the drain began, so the notice can tell a stop from an update. */
  shutdownReason?(): string;
}

/** Dependencies of the dependency-readiness guard. */
export interface ReadinessMiddlewareDeps {
  readonly readiness: () => Promise<ReadinessCheckResult>;
  readonly shutdownCoordinator?: ShutdownDrainSource;
}

/**
 * The minimal parse surface the canonical-parse stage needs from a surface
 * adapter. Hoisted here so the pipeline, the composition root (`app.ts`), and
 * the guard stage all share one name for the injected adapter map.
 */
export interface CanonicalAdapter {
  parse(input: { body: unknown; headers: Record<string, string>; path: string }): CanonicalRequest;
}

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

/** One native service: the path it is served at and the kind its models carry. */
export interface NativeServiceRoute {
  readonly serviceKind: Exclude<ServiceKind, "llm">;
  readonly path: string;
}

export const NATIVE_SERVICES: readonly NativeServiceRoute[] = [
  { serviceKind: "systemone", path: "/v1/systemone" },
  { serviceKind: "websearch", path: "/v1/search" },
  { serviceKind: "imageGeneration", path: "/v1/images/generations" },
  { serviceKind: "videoGeneration", path: "/v1/videos/generations" },
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
