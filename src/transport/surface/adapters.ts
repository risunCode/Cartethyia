// Shared surface wire readers, detection, and adapter registry.
import type { CanonicalEvent, SourceSurface } from "../canonical-model";
import { getHeader } from "../canonical-model";
import { isRecord } from "../../protocol/primitives";

/** Shared surface wire readers, detection, and adapter registry helpers. */

/**
 * Helper for Messages dialect: throws if value is not a record.
 */
export function requiredObject(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

/** Extracts text content from a content_delta CanonicalEvent. */
export function eventText(event: CanonicalEvent): string | undefined {
  return event.type === "content_delta" && event.content.kind === "text"
    ? event.content.text
    : undefined;
}


// Once-only surface detection with fixed precedence:
// explicit header → endpoint path → unambiguous body shape → chat default.
// The endpoint path is authoritative: user-agent sniffing and prompt-text
// marker scanning never override it, so routing cannot depend on client
// identity strings or prompt content.
export type WinningSource =
  "explicit_marker" | "body_shape" | "endpoint_path";

export interface SurfaceInput {
  headers: Record<string, string>;
  body: unknown;
  path: string;
}

export interface SurfaceDetection {
  surface: SourceSurface;
  winning_source: WinningSource;
  /**
   * Every signal that was evaluated, in precedence order — not just the winner.
   * Two signals naming different surfaces is the disagreement case below, and
   * it is what makes a lower-precedence signal worth keeping at all.
   */
  signals: Array<{ source: WinningSource; surface: SourceSurface }>;
  /** True when the evaluated signals did not all name the same surface. */
  disagreement: boolean;
}

export interface SurfaceAdapter {
  surface: SourceSurface;
  /**
   * Whether the body shape is compatible with this adapter's wire format.
   * Must be a pure shape check: no side effects, no prompt-text scanning
   * beyond the adapter's own expected top-level fields.
   */
  matchesBodyShape(body: unknown): boolean;
}

/**
 * Single source of truth for surface configuration: one entry per surface,
 * with the endpoint prefix that identifies it and the marker value that names
 * it explicitly. Both detection lookups read this table, so adding a surface
 * is one row here plus its adapter.
 */
export interface SurfaceDescriptor {
  readonly surface: SourceSurface;
  readonly pathPrefix: string;
}

export const SURFACE_DESCRIPTORS: readonly SurfaceDescriptor[] = [
  {
    surface: "chat",
    pathPrefix: "/v1/chat/completions",
  },
  {
    surface: "responses",
    pathPrefix: "/v1/responses",
  },
  {
    surface: "messages",
    pathPrefix: "/v1/messages",
  },
  {
    surface: "completion",
    pathPrefix: "/v1/completions",
  },
] as const;


function explicitMarkerSurface(input: SurfaceInput): SourceSurface | undefined {
  const h = getHeader(input.headers, "x-cartethyia-surface");
  if (!h) return undefined;
  const v = h.trim().toLowerCase();
  return SURFACE_DESCRIPTORS.find((d) => d.surface === v)?.surface;
}

function bodyShapeMatches(input: SurfaceInput, adapters: SurfaceAdapter[]): SourceSurface[] {
  if (!input.body || typeof input.body !== "object") return [];
  const matches: SourceSurface[] = [];
  for (const a of adapters) {
    if (a.matchesBodyShape(input.body)) matches.push(a.surface);
  }
  return matches;
}

function endpointPathSurface(path: string): SourceSurface | undefined {
  const p = path.split("?")[0] ?? "";
  for (const d of SURFACE_DESCRIPTORS) {
    if (p === d.pathPrefix || p.startsWith(d.pathPrefix + "/")) return d.surface;
  }
  return undefined;
}

export class SurfaceAdapterRegistry {
  constructor(private readonly adapters: SurfaceAdapter[]) {
    if (!adapters || adapters.length === 0) {
      throw new Error("SurfaceAdapterRegistry requires at least one adapter");
    }
  }

  /**
   * Evaluates every signal once, then picks a winner by the fixed precedence
   * above. Evaluating all three even when an earlier signal already wins is
   * deliberate: the losing signals are what `disagreement` reports, and that is
   * the only thing that would surface a client whose marker and path conflict.
   */
  detectOnce(input: SurfaceInput): SurfaceDetection {
    const explicit = explicitMarkerSurface(input);
    const endpoint = endpointPathSurface(input.path);
    const bodyMatches = bodyShapeMatches(input, this.adapters);
    const soleBodyMatch = bodyMatches.length === 1 ? bodyMatches[0] : undefined;

    const signals: Array<{ source: WinningSource; surface: SourceSurface }> = [];
    if (explicit) signals.push({ source: "explicit_marker", surface: explicit });
    if (endpoint) signals.push({ source: "endpoint_path", surface: endpoint });
    if (soleBodyMatch) signals.push({ source: "body_shape", surface: soleBodyMatch });

    if (explicit) return this.buildDetection(explicit, "explicit_marker", signals);
    if (endpoint) return this.buildDetection(endpoint, "endpoint_path", signals);
    if (soleBodyMatch) return this.buildDetection(soleBodyMatch, "body_shape", signals);

    // No signal matched — default to chat as the most permissive surface for
    // the single-endpoint fallback; detection must still return a surface so
    // every downstream consumer has a deterministic one.
    return this.buildDetection("chat", "endpoint_path", signals);
  }

  private buildDetection(
    surface: SourceSurface,
    winning_source: WinningSource,
    signals: Array<{ source: WinningSource; surface: SourceSurface }>,
  ): SurfaceDetection {
    const distinctSurfaces = new Set(signals.map((s) => s.surface));
    return {
      surface,
      winning_source,
      signals,
      disagreement: distinctSurfaces.size > 1,
    };
  }
}

/** Surface output bytes produced after canonical response translation. */
export interface SurfaceOutput {
  readonly bytes: Uint8Array;
  readonly content_type: string;
}
