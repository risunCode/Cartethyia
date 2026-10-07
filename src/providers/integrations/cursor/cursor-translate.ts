/**
 * Canonical messages to Cursor history, and back.
 *
 * Cursor composes the model prompt itself and discards a real `system` role,
 * so a caller's system message is delivered as the opening exchange of the
 * history, labelled as configuration from the gateway operator. The model
 * follows it in practice and sometimes declines part of it; that answer is
 * passed through unchanged.
 */
import type { CanonicalMessage, ContentPart } from "../../../protocol/canonical-model";
import type { CursorTool } from "./cursor-messages";

const SYSTEM_LEAD_IN = "Configuration for this session, set by the operator of this API gateway:";
const SYSTEM_ACK = "Understood. I will follow that configuration for the rest of this conversation.";

export interface TurnInput {
  /** History, oldest first, excluding the active user message. */
  readonly rootMessages: readonly unknown[];
  /** Absent when the caller is mid tool loop and the turn should resume. */
  readonly userText: string | undefined;
  readonly tools: readonly CursorTool[];
}

export function buildTurnInput(messages: readonly CanonicalMessage[], tools: readonly CursorTool[]): TurnInput {
  // The active user message is the trailing user turn. A request that ends on
  // a tool result is mid-loop and gets a resume instead of an empty message.
  let activeIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "developer") {
      activeIndex = i;
      break;
    }
    if (role === "tool" || role === "assistant") break;
  }

  const rootMessages: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === activeIndex) continue;
    const message = messages[i];
    if (!message) continue;
    if (message.role === "system" || message.role === "developer") {
      const text = textOf(message.content);
      if (!text) continue;
      rootMessages.push(historyEntry("user", `${SYSTEM_LEAD_IN}\n\n${text}`));
      rootMessages.push(historyEntry("assistant", SYSTEM_ACK));
      continue;
    }
    if (message.role === "user") {
      const text = textOf(message.content);
      if (text) rootMessages.push(historyEntry("user", text));
      continue;
    }
    if (message.role === "assistant") {
      const parts: unknown[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ type: "text", text });
      for (const part of message.content) {
        if (part.kind !== "toolCall") continue;
        parts.push({
          type: "tool-call",
          toolCallId: part.call_id,
          toolName: part.name,
          args: part.arguments,
        });
      }
      if (parts.length > 0) rootMessages.push({ role: "assistant", content: parts });
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.kind !== "toolResult") continue;
        rootMessages.push({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: part.call_id, result: resultText(part.content) }],
        });
      }
    }
  }

  const active = activeIndex >= 0 ? messages[activeIndex] : undefined;
  return {
    rootMessages,
    userText: active ? textOf(active.content) : undefined,
    tools,
  };
}

function historyEntry(role: string, text: string): unknown {
  return { role, content: [{ type: "text", text }] };
}

function textOf(content: readonly ContentPart[]): string {
  return content.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}

function resultText(content: readonly ContentPart[] | string): string {
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}

/** Cursor tools from the caller's declared tool set. */
export function cursorTools(tools: readonly { readonly name: string; readonly description?: string; readonly jsonSchema: unknown }[]): readonly CursorTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    inputSchemaJson: JSON.stringify(tool.jsonSchema ?? { type: "object", properties: {} }),
  }));
}
