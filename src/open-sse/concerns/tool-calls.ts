import type { ContentBlock, NormalizedMessage, ProxyRequest } from "../../application/contracts";

/** Ensures every normalized tool-use block has a stable call identifier. */
export function ensureToolCallIds(request: ProxyRequest): ProxyRequest {
  let changed = false;
  const messages = request.messages.map((message, messageIndex): NormalizedMessage => {
    let messageChanged = false;
    const content = message.content.map((block, blockIndex): ContentBlock => {
      if (block.type !== "tool_use" || block.toolCallId !== undefined && block.toolCallId.length > 0) return block;
      messageChanged = true;
      changed = true;
      return { ...block, toolCallId: `call_${messageIndex}_${blockIndex}` };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? { ...request, messages } : request;
}

/**
 * Adds empty tool responses for tool calls that have no matching result.
 * This keeps protocol adapters from emitting an assistant tool call followed
 * by an invalid conversation boundary while preserving all supplied results.
 */
export function fixMissingToolResponses(request: ProxyRequest): ProxyRequest {
  const normalized = ensureToolCallIds(request);
  const responded = new Set<string>();
  for (const message of normalized.messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.toolCallId !== undefined) responded.add(block.toolCallId);
    }
  }

  const messages: NormalizedMessage[] = [];
  let added = false;
  for (const message of normalized.messages) {
    messages.push(message);
    if (message.role !== "assistant") continue;
    const missing = message.content
      .filter((block) => block.type === "tool_use" && block.toolCallId !== undefined && !responded.has(block.toolCallId))
      .map((block) => ({ type: "tool_result" as const, toolCallId: block.toolCallId, text: "" }));
    if (missing.length === 0) continue;
    messages.push({ role: "tool", content: missing });
    added = true;
  }
  return added ? { ...normalized, messages } : normalized;
}
