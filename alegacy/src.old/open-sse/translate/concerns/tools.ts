import type { ContentBlock, NormalizedMessage, ProxyRequest } from "../../../application/contracts";

export interface ToolCallRecord {
  readonly sourceId: string;
  readonly targetId: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolResultRecord {
  readonly sourceId: string;
  readonly targetId: string;
  readonly isError: boolean;
}

export type ToolRepairKind = "generated-id" | "sanitized-id" | "duplicate-result" | "missing-result" | "merged-message" | "orphan-result";

export interface ToolRepairChange {
  readonly kind: ToolRepairKind;
  readonly sourceId?: string;
  readonly targetId?: string;
  readonly messageIndex?: number;
}

export interface ToolRepairResult {
  readonly request: ProxyRequest;
  readonly ledger: ToolCallLedger;
  readonly changes: readonly ToolRepairChange[];
}

export interface ToolCallLedger {
  readonly calls: ReadonlyMap<string, ToolCallRecord>;
  readonly results: ReadonlyMap<string, ToolResultRecord>;
  repair(): ToolRepairResult;
}

const MAX_TOOL_CALL_ID_LENGTH = 64;
const MAX_TOOL_ARGUMENT_LENGTH = 128_000;

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

/** Repairs tool identifiers, results, and adjacent conversation boundaries immutably. */
export function repairToolCallRequest(request: ProxyRequest): ToolRepairResult {
  return createToolCallLedger(request).repair();
}

/** Creates a deterministic ledger for one canonical request. */
export function createToolCallLedger(request: ProxyRequest): ToolCallLedger {
  const calls = new Map<string, ToolCallRecord>();
  const results = new Map<string, ToolResultRecord>();
  const idMap = new Map<string, string>();
  const changes: ToolRepairChange[] = [];
  const usedIds = new Set<string>();

  for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
    const message = request.messages[messageIndex];
    if (message === undefined) continue;
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
      const block = message.content[blockIndex];
      if (block === undefined || block.type !== "tool_use") continue;
      const sourceId = block.toolCallId?.trim() || `call_${messageIndex}_${blockIndex}`;
      const targetId = allocateTargetId(sourceId, usedIds);
      idMap.set(sourceId, targetId);
      if (sourceId !== targetId) changes.push({ kind: block.toolCallId === undefined ? "generated-id" : "sanitized-id", sourceId, targetId, messageIndex });
      calls.set(targetId, {
        sourceId,
        targetId,
        name: block.toolName ?? "tool",
        arguments: stringifyToolArguments(block.toolArguments),
      });
    }
  }

  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const sourceId = block.toolCallId?.trim() ?? "";
      const targetId = idMap.get(sourceId) ?? allocateTargetId(sourceId || "orphan", usedIds);
      if (!idMap.has(sourceId)) changes.push({ kind: "orphan-result", sourceId, targetId });
      if (!results.has(targetId)) results.set(targetId, { sourceId, targetId, isError: block.toolResultIsError === true });
    }
  }

  return {
    calls,
    results,
    repair(): ToolRepairResult {
      const responded = new Set(results.keys());
      const seenResults = new Set<string>();
      const repairedMessages: NormalizedMessage[] = [];
      let changed = false;

      for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
        const message = request.messages[messageIndex];
        if (message === undefined) continue;
        const content: ContentBlock[] = [];
        for (const block of message.content) {
          if (block.type === "tool_use") {
            const sourceId = block.toolCallId?.trim() || `call_${messageIndex}_${content.length}`;
            const targetId = idMap.get(sourceId) ?? allocateTargetId(sourceId, usedIds);
            const repaired = { ...block, toolCallId: targetId, toolArguments: stringifyToolArguments(block.toolArguments) };
            content.push(repaired);
            if (repaired.toolCallId !== block.toolCallId || repaired.toolArguments !== block.toolArguments) changed = true;
            continue;
          }
          if (block.type === "tool_result") {
            const sourceId = block.toolCallId?.trim() ?? "";
            const targetId = idMap.get(sourceId) ?? sourceId;
            if (targetId !== "" && seenResults.has(targetId)) {
              changes.push({ kind: "duplicate-result", sourceId, targetId });
              changed = true;
              continue;
            }
            if (targetId !== "") seenResults.add(targetId);
            content.push(targetId === block.toolCallId ? block : { ...block, toolCallId: targetId || undefined });
            continue;
          }
          content.push(block);
        }
        const repairedMessage = content.length === message.content.length && content.every((block, index) => block === message.content[index])
          ? message
          : { ...message, content };
        repairedMessages.push(repairedMessage);
        if (message.role === "assistant") {
          const missing = repairedMessage.content
            .filter((block): block is ContentBlock & { readonly toolCallId: string } => block.type === "tool_use" && typeof block.toolCallId === "string" && !responded.has(block.toolCallId))
            .map((block) => ({ type: "tool_result" as const, toolCallId: block.toolCallId, text: "" }));
          if (missing.length > 0) {
            repairedMessages.push({ role: "tool", content: missing });
            for (const block of missing) responded.add(block.toolCallId);
            changes.push(...missing.map((block) => ({ kind: "missing-result" as const, targetId: block.toolCallId, messageIndex })));
            changed = true;
          }
        }
      }

      const merged = mergeAdjacentMessages(repairedMessages, changes);
      if (merged.length !== repairedMessages.length) changed = true;
      return { request: changed ? { ...request, messages: merged } : request, ledger: this, changes: [...changes] };
    },
  };
}

/** Converts object arguments into bounded JSON strings for wire formats that require strings. */
export function stringifyToolArguments(value: unknown): string {
  if (typeof value === "string") {
    if (value.length > MAX_TOOL_ARGUMENT_LENGTH) throw new RangeError(`tool arguments exceed ${MAX_TOOL_ARGUMENT_LENGTH} characters`);
    return value;
  }
  if (value === undefined || value === null) return "{}";
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "{}";
  if (serialized.length > MAX_TOOL_ARGUMENT_LENGTH) throw new RangeError(`tool arguments exceed ${MAX_TOOL_ARGUMENT_LENGTH} characters`);
  return serialized;
}

/** Adds empty tool responses for tool calls that have no matching result. */
export function fixMissingToolResponses(request: ProxyRequest): ProxyRequest {
  return repairToolCallRequest(request).request;
}

function allocateTargetId(sourceId: string, usedIds: Set<string>): string {
  const base = sanitizeToolCallId(sourceId);
  let target = base;
  let suffix = 2;
  while (usedIds.has(target)) target = `${base.slice(0, MAX_TOOL_CALL_ID_LENGTH - String(suffix).length - 1)}_${suffix++}`;
  usedIds.add(target);
  return target;
}

function sanitizeToolCallId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "").slice(0, MAX_TOOL_CALL_ID_LENGTH);
  return normalized === "" ? "call_generated" : normalized;
}

function mergeAdjacentMessages(messages: readonly NormalizedMessage[], changes: ToolRepairChange[]): NormalizedMessage[] {
  const merged: NormalizedMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous === undefined || previous.role !== message.role) {
      merged.push(message);
      continue;
    }
    merged[merged.length - 1] = { ...previous, content: [...previous.content, ...message.content] };
    changes.push({ kind: "merged-message" });
  }
  return merged;
}
