/**
 * Reads a gateway SSE response and reports each visible text delta.
 * The caller owns the assistant bubble; this only walks the wire.
 */

import { errorMessage, reasoningDelta, takeSseEvents, textDelta, usageDelta, type LabProtocol, type LabUsageDelta } from "./protocol";

export async function readLabStream(
  response: Response,
  protocol: LabProtocol,
  onDelta: (text: string) => void,
  onReasoning: (text: string) => void,
  onUsage: (usage: LabUsageDelta) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(errorMessage(payload, response.status));
  }
  if (response.body === null) throw new Error("The gateway returned an empty stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Stopped");
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const taken = takeSseEvents(buffer);
      buffer = taken.rest;
      for (const event of taken.events) {
        if (event.data === "[DONE]") return;
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          continue;
        }
        const delta = textDelta(protocol, event.event, payload);
        if (delta.length > 0) onDelta(delta);
        const thought = reasoningDelta(protocol, event.event, payload);
        if (thought.length > 0) onReasoning(thought);
        const usage = usageDelta(protocol, event.event, payload);
        if (usage.inputTokens !== undefined || usage.cachedTokens !== undefined || usage.outputTokens !== undefined || usage.reasoningTokens !== undefined || usage.status !== undefined) {
          onUsage(usage);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
