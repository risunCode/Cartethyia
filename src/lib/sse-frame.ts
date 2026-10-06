/**
 * Pure SSE frame builders — shared by the transport streaming encoders
 * and the console dashboard SSE endpoints. Lives in `src/lib/` because
 * the frame format is a wire detail with no layer ownership: both the
 * data plane (`transport/surface/*`) and the control plane
 * (`console/observability/sse.ts`) need the same bytes, and keeping it in
 * `transport/` forced console code to reach across the layer boundary.
 *
 * `SurfaceStreamEncoder` stays in `transport/surface/stream-frame.ts`: it
 * is the surface-adapter contract and has no console consumer.
 */

export const TEXT_ENCODER = new TextEncoder();

/** Single SSE named-event template shared by every layer (gateway and console). */
export function buildSseEventFrame(event: string, payload: string): string {
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/**
 * Format a Server-Sent Event frame with named event and data.
 * Produces `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
 */
export function formatSseEvent(event: string, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return TEXT_ENCODER.encode(buildSseEventFrame(event, payload));
}

/**
 * Format a Server-Sent Event data-only frame.
 * Produces `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
 */
export function formatSseData(data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return TEXT_ENCODER.encode(`data: ${payload}\n\n`);
}
