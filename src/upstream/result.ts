/**
 * Stream materialization — drains an AsyncGenerator<StreamEvent> into a
 * fully-resolved Chat response shape. Used by providers whose upstream
 * protocol is streaming-only (commandcode, devin, qoder).
 */

import type { AnthropicStopReason } from "../translate/concerns/finishReasons";
import type { OpenAIChatResponse } from "../translate/types";
import type { StreamEvent } from "./bridge";

interface MaterializedResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: AnthropicStopReason;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export async function materializeFromStream(events: AsyncGenerator<StreamEvent>): Promise<MaterializedResult> {
  let text = "";
  const toolsById = new Map<string, { id: string; name: string; arguments: string }>();
  let finishReason: AnthropicStopReason = "end_turn";
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for await (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        text += ev.text;
        break;
      case "tool_call_start": {
        const existing = toolsById.get(ev.id);
        if (!existing) toolsById.set(ev.id, { id: ev.id, name: ev.name, arguments: "" });
        else if (existing.name !== ev.name) existing.name = ev.name;
        break;
      }
      case "tool_call_args_delta": {
        const existing = toolsById.get(ev.id);
        if (existing) existing.arguments += ev.argumentsDelta;
        break;
      }
      case "finish":
        finishReason = ev.stopReason;
        break;
      case "usage":
        usage = {
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          cacheReadTokens: ev.cacheReadTokens,
          cacheWriteTokens: ev.cacheWriteTokens,
        };
        break;
    }
  }

  return {
    text,
    toolCalls: [...toolsById.values()],
    finishReason,
    usage,
  };
}

export function materializedToChatResponse(result: MaterializedResult, model: string): OpenAIChatResponse {
  const finishReason = anthropicStopToOpenAIFinish(result.finishReason, result.toolCalls.length > 0);

  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: result.text,
  };

  if (result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: result.usage.inputTokens + result.usage.cacheReadTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.outputTokens,
      prompt_tokens_details: { cached_tokens: result.usage.cacheReadTokens },
      cache_write_tokens: result.usage.cacheWriteTokens,
    },
  };
}

function anthropicStopToOpenAIFinish(reason: AnthropicStopReason, hadToolCalls: boolean): string {
  if (hadToolCalls) return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "content_filter";
  return "stop";
}
