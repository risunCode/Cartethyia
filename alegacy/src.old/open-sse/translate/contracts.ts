import type { StreamEvent, Surface } from "../../application/contracts";

/** Canonical non-stream response representation shared by all provider surfaces. */
export interface ResponseDocument {
  readonly sourceSurface: Surface;
  readonly model: string;
  readonly events: readonly StreamEvent[];
  readonly rawBody?: Record<string, unknown>;
}
