/**
 * Canonical → Codex Responses wire body. Owns:
 * - message input rendering
 * - orphaned tool-call/result repair before the payload hits the wire
 * - reasoning item shape (encrypted/summary variants)
 * - Harmony control-token escaping for gpt-5/gpt-oss dialects
 * - reasoning include/effort/summary/context wiring
 * - Responses Lite reasoning override + body shape mutation
 */
import type { CanonicalMessage, CanonicalRequest, ContentPart } from "../../transport/canonical-model";
import { canContainToolResult, toolResultParts } from "../../transport/canonical-model";
import { reasoningEffortFromIntent } from "../../providers/reasoning";
import {
  decodeCodexToolCallId,
  encodeCodexToolCallId,
  escapeHarmonyControlTokensDeep,
  hashToBase36,
  isClaudeBillingHeaderText,
  mapReasoningEffortToWireTier,
  tryParseJsonObject,
} from "../primitives";

/**
 * Repairs branched/aborted tool-call histories before they hit the wire
 * (gap report P3.5 "Orphan / interrupted tool I/O repair"). A tool call
 * with no matching result gets a synthesized placeholder result inserted
 * right after it; a tool result with no matching call gets folded into a
 * plain user-visible note instead of being sent as an unpaired
 * `function_call_output` (which the backend rejects with "No tool call
 * found for ... output").
 */
function repairOrphanedCodexToolExchanges(
  messages: readonly CanonicalMessage[],
): readonly CanonicalMessage[] {
  const calledIds = new Set<string>();
  const resultedIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const p of m.content)
        if (p.kind === "toolCall") calledIds.add(p.call_id);
    } else if (canContainToolResult(m)) {
      // Results live in `tool` turns or in `user` turns (the Messages ledger
      // re-homes them). A `role === "tool"`-only scan missed every
      // Messages-origin history, so its results read as orphaned and its
      // calls as unanswered — the repair then rewrote a valid exchange.
      for (const p of m.content)
        if (p.kind === "toolResult") resultedIds.add(p.call_id);
    }
  }
  const orphanedCalls = new Set(
    [...calledIds].filter((id) => !resultedIds.has(id)),
  );
  const orphanedResults = new Set(
    [...resultedIds].filter((id) => !calledIds.has(id)),
  );
  if (orphanedCalls.size === 0 && orphanedResults.size === 0) return messages;

  const repaired: CanonicalMessage[] = [];
  for (const m of messages) {
    const orphanResults = toolResultParts(m).filter((p) => orphanedResults.has(p.call_id));
    if (orphanResults.length > 0) {
      // Fold the unpaired result into a plain user note instead of sending it
      // as an unpaired `function_call_output`. Applies to any turn that may
      // carry a result (`tool` or `user`), preserving the turn's own role for
      // whatever content survives.
      const kept = m.content.filter(
        (p) => !(p.kind === "toolResult" && orphanedResults.has(p.call_id)),
      );
      const foldedNotes = orphanResults.map((p) => {
        const text = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
        return `[Previous tool result; call_id=${p.call_id}]: ${text.slice(0, 16_000)}`;
      });
      if (kept.length > 0) repaired.push({ ...m, content: kept });
      repaired.push({
        role: "user",
        content: [{ kind: "text", text: foldedNotes.join("\n\n") }],
      });
      continue;
    }
    repaired.push(m);
    if (m.role === "assistant") {
      const orphanedHere = m.content.filter(
        (p): p is Extract<ContentPart, { kind: "toolCall" }> =>
          p.kind === "toolCall" && orphanedCalls.has(p.call_id),
      );
      if (orphanedHere.length > 0) {
        repaired.push({
          role: "tool",
          content: orphanedHere.map((tc) => ({
            kind: "toolResult" as const,
            call_id: tc.call_id,
            content:
              "[No tool output found — the turn was interrupted before a result was produced]",
            is_error: true,
          })),
        });
      }
    }
  }
  return repaired;
}

function codexToolWireIds(callId: string, itemId?: string): {
  readonly callId: string;
  readonly itemId: string;
} {
  const composite = encodeCodexToolCallId(callId, itemId);
  const separator = composite.indexOf("__");
  return {
    callId: decodeCodexToolCallId(callId),
    itemId: separator === -1 ? composite : composite.slice(separator + 2),
  };
}
export function canonicalToCodexResponsesPayload(
  request: CanonicalRequest,
  opts?: {
    responsesLite?: boolean;
    /**
     * Concurrent reasoning-summary delivery (codex-rs
     * `concurrent_reasoning_summaries`): emits
     * `stream_options.reasoning_summary_delivery = "sequential_cutoff"` when a
     * summary was requested. Off by default — the mode cancels in-flight
     * summary sections when the reasoning item closes and is
     * `UnderDevelopment` in codex-rs, matching the reference implementation.
     */
    concurrentReasoningSummaries?: boolean;
  },
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  // The Codex backend rejects `role: "system"` input items outright
  // ("System messages are not allowed"), so system content travels in the
  // top-level `instructions` string — the field the Responses wire defines for
  // it. `request.instructions` is developer-scoped content and stays a
  // `developer` message, which the backend accepts.
  const systemText: string[] = [];
  if (request.system !== undefined) {
    for (const part of request.system) {
      if (part.kind === "text" && !isClaudeBillingHeaderText(part.text)) systemText.push(part.text);
    }
  }
  if (request.instructions !== undefined) {
    for (const part of request.instructions) {
      if (part.kind === "text") {
        input.push({
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: part.text }],
        });
      }
    }
  }
  const emitToolResults = (message: CanonicalMessage): void => {
    for (const part of message.content) {
      if (part.kind !== "toolResult") continue;
      const wireCallId = decodeCodexToolCallId(part.call_id);
      const callKind = part.call_kind ?? "function";
      if (callKind === "custom") {
        input.push({
          type: "custom_tool_call_output",
          call_id: wireCallId,
          output: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
        });
      } else if (callKind === "computer") {
        let imageUrl: unknown;
        if (typeof part.content === "string") {
          imageUrl = part.content;
        } else {
          const imagePart = part.content.find((p) => p.kind === "image");
          imageUrl =
            imagePart !== undefined && imagePart.kind === "image"
              ? imagePart.payload
              : JSON.stringify(part.content);
        }
        input.push({
          type: "computer_call_output",
          call_id: wireCallId,
          output: { type: "computer_screenshot", image_url: imageUrl },
        });
      } else {
        input.push({
          type: "function_call_output",
          call_id: wireCallId,
          output: typeof part.content === "string" ? part.content : JSON.stringify(part.content),
        });
      }
    }
  };

  const repairedMessages = repairOrphanedCodexToolExchanges(request.messages);
  for (const message of repairedMessages) {
    // A system-role turn in the message list is the same rejected shape as a
    // system input item, so it folds into the top-level `instructions` string
    // too. Only `user` and `developer` turns become input messages.
    if (message.role === "system") {
      const text = message.content
        .filter((p) => p.kind === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
      if (text.length > 0) systemText.push(text);
      continue;
    }
    // The Messages ledger re-homes tool answers to user turns. They must be
    // emitted as Responses output items, not swallowed by the user text renderer.
    if (message.role === "user") emitToolResults(message);
    if (message.role === "user" || message.role === "developer") {
      const text = message.content
        .filter((p) => p.kind === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
      const images = message.content.filter((p) => p.kind === "image");
      if (text.length === 0 && images.length === 0) continue;
      const content: Array<Record<string, unknown>> = [];
      if (text.length > 0) content.push({ type: "input_text", text });
      for (const img of images) {
        const payload = (img as { payload: unknown }).payload;
        // Canonical image parts don't carry `detail` today; forward as
        // `image_url`. When a payload object already declares `detail`,
        // preserve it so the Lite shaping pass can strip it.
        if (
          payload !== null &&
          typeof payload === "object" &&
          "image_url" in (payload as Record<string, unknown>)
        ) {
          const imgObj = payload as Record<string, unknown>;
          const entry: Record<string, unknown> = {
            type: "input_image",
            image_url: imgObj["image_url"],
          };
          if (typeof imgObj["detail"] === "string")
            entry["detail"] = imgObj["detail"];
          content.push(entry);
        } else {
          content.push({ type: "input_image", image_url: payload });
        }
      }
      input.push({ type: "message", role: message.role, content });
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.kind === "toolCall") {
          const tc = part as Extract<typeof part, { kind: "toolCall" }>;
          const wireIds = codexToolWireIds(tc.call_id, tc.item_id);
          const callKind = tc.call_kind ?? "function";
          if (callKind === "custom") {
            input.push({
              type: "custom_tool_call",
              call_id: wireIds.callId,
              id: wireIds.itemId,
              name: tc.name,
              input:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
            });
          } else if (callKind === "computer") {
            const action =
              typeof tc.arguments === "string"
                ? (tryParseJsonObject(tc.arguments) ?? {})
                : (tc.arguments ?? {});
            input.push({
              type: "computer_call",
              call_id: wireIds.callId,
              id: wireIds.itemId,
              action,
            });
          } else {
            input.push({
              type: "function_call",
              call_id: wireIds.callId,
              id: wireIds.itemId,
              name: tc.name,
              arguments:
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments),
            });
          }
        } else if (part.kind === "text") {
          input.push({
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: (part as { text: string }).text },
            ],
          });
        } else if (part.kind === "reasoning") {
          const r = part as Extract<typeof part, { kind: "reasoning" }>;
          if (
            typeof r.encrypted_content === "string" &&
            r.encrypted_content.length > 0
          ) {
            const summaryArray =
              r.summary === undefined
                ? []
                : [{ type: "summary_text", text: r.summary }];
            const item: Record<string, unknown> = {
              type: "reasoning",
              summary: summaryArray,
              encrypted_content: r.encrypted_content,
            };
            if (r.summary !== undefined || r.encrypted_content !== undefined) {
              const idSource = `${r.summary ?? ""}|${r.encrypted_content ?? ""}`;
              if (idSource.length > 1) {
                item["id"] = `rs_${hashToBase36(idSource)}`;
              }
            }
            input.push(item);
          } else if (r.summary !== undefined) {
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: r.summary }],
            });
          }
        }
      }
    } else if (message.role === "tool") {
      emitToolResults(message);
    }
  }
  // Harmony escaping is limited to models whose wire dialect consumes these
  // control tokens.
  const lowerModel = request.model.toLowerCase();
  const isHarmonyDialect =
    lowerModel.includes("gpt-oss") || lowerModel.includes("gpt-5");
  const escapedInput = isHarmonyDialect
    ? input.map(
        (item) =>
          escapeHarmonyControlTokensDeep(item) as Record<string, unknown>,
      )
    : input;

  const payload: Record<string, unknown> = {
    model: request.model,
    input: escapedInput,
    // Codex Responses is always consumed as a streaming protocol. Do not
    // forward client control values that this backend does not implement.
    stream: true,
    store: false,
  };
  // System-scoped content rides here rather than as a system input item, which
  // the backend rejects. Omitted entirely when there is none, so a plain user
  // turn does not carry an empty field.
  const instructions = systemText.join("\n\n").trim();
  if (instructions.length > 0) payload["instructions"] = instructions;
  if (request.tools !== undefined && request.tools.length > 0) {
    payload["tools"] = request.tools.map((tool) => {
      if (tool.tool_type === "custom") {
        return {
          type: "custom",
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.jsonSchema !== null &&
          typeof tool.jsonSchema === "object" &&
          !Array.isArray(tool.jsonSchema) &&
          Object.keys(tool.jsonSchema as Record<string, unknown>).length > 0
            ? { format: tool.jsonSchema }
            : {}),
        };
      }
      if (
        tool.tool_type !== undefined &&
        tool.tool_type !== "function" &&
        tool.jsonSchema !== null &&
        typeof tool.jsonSchema === "object" &&
        !Array.isArray(tool.jsonSchema)
      )
        return tool.jsonSchema;
      return {
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.jsonSchema,
        ...(tool.strict === true ? { strict: true } : {}),
      };
    });
  }
  if (request.tool_choice !== undefined) {
    if (typeof request.tool_choice === "string") payload["tool_choice"] = request.tool_choice;
    else if (request.tool_choice.type === "tool")
      payload["tool_choice"] = { type: "function", name: request.tool_choice.name };
    else if (request.tool_choice.type === "custom")
      payload["tool_choice"] = { type: "custom", name: request.tool_choice.name };
    else payload["tool_choice"] = request.tool_choice;
  }
  let hasReasoningSummary = false;
  const hasEncryptedReasoning = request.messages.some((message) =>
    message.content.some(
      (part) =>
        part.kind === "reasoning" &&
        typeof part.encrypted_content === "string" &&
        part.encrypted_content.length > 0,
    ),
  );
  if (request.reasoning !== undefined) {
    // Derive the tier from the canonical intent (including an Anthropic-shaped
    // `thinking` block, which carries `budget_tokens` rather than an effort)
    // so this wire never receives a field it does not define.
    const wireEffort = mapReasoningEffortToWireTier(reasoningEffortFromIntent(request.reasoning));
    const reasoningPayload: Record<string, unknown> = {};
    if (wireEffort !== undefined) reasoningPayload["effort"] = wireEffort;
    if (request.reasoning.summary_mode !== undefined) {
      reasoningPayload["summary"] = request.reasoning.summary_mode;
    } else if (request.reasoning.summary !== undefined) {
      reasoningPayload["summary"] = request.reasoning.summary;
    } else if (wireEffort !== undefined && wireEffort !== "none") {
      reasoningPayload["summary"] = "auto";
    }
    hasReasoningSummary = typeof reasoningPayload["summary"] === "string";
    // The Codex wire only accepts `mode: "pro"` (reference `ReasoningConfig`);
    // canonical `"standard"` is the default and must stay omitted rather than
    // being sent as an unrecognized upstream value.
    if (request.reasoning.mode === "pro") reasoningPayload["mode"] = "pro";
    if (request.reasoning.context !== undefined)
      reasoningPayload["context"] = request.reasoning.context;
    // Emit only the fields the Responses wire defines. When the canonical
    // intent carries no wire-mappable field (an Anthropic `thinking` block with
    // only `budget_tokens`/`thinking_type`, say), this object stays empty and
    // the field is omitted entirely — the previous `else payload["reasoning"] =
    // request.reasoning` forwarded the canonical object verbatim, sending
    // Anthropic-only keys (`budget_tokens`, `thinking_type`, `display`,
    // `task_budget`, `prefix_mismatch_behavior`) to an upstream that rejects
    // unknown fields with a 400.
    if (Object.keys(reasoningPayload).length > 0) payload["reasoning"] = reasoningPayload;
  }
  if (opts?.responsesLite === true) {
    const reasoning =
      payload["reasoning"] !== null && typeof payload["reasoning"] === "object"
        ? { ...(payload["reasoning"] as Record<string, unknown>) }
        : {};
    reasoning["context"] = "all_turns";
    payload["reasoning"] = reasoning;
  }
  if (request.reasoning !== undefined || hasEncryptedReasoning) {
    const existingInclude = Array.isArray(payload["include"])
      ? (payload["include"] as string[])
      : [];
    const includeSet = new Set<string>(existingInclude);
    includeSet.add("reasoning.encrypted_content");
    payload["include"] = [...includeSet];
  }
  // Codex accepts output verbosity only through the nested `text` object; the
  // flat canonical `generation_controls.verbosity` never goes upstream alone.
  if (request.generation_controls.verbosity !== undefined) {
    payload["text"] = { verbosity: request.generation_controls.verbosity };
  }
  // Concurrent reasoning summaries are opt-in and only meaningful once a
  // summary was requested (codex-rs `concurrent_reasoning_summaries`).
  if (opts?.concurrentReasoningSummaries === true && hasReasoningSummary) {
    payload["stream_options"] = {
      reasoning_summary_delivery: "sequential_cutoff",
    };
  }
  if (request.response_format !== undefined)
    payload["response_format"] = request.response_format;
  if (request.cache_hint !== undefined) {
    payload["prompt_cache_key"] =
      request.cache_hint === "stable_prefix"
        ? "stable_prefix"
        : `breakpoints:${request.cache_hint.list.join(",")}`;
  }
  // Generation controls (temperature, top_p, max_tokens, etc.) are not
  // accepted by the Codex Responses backend and must never leak upstream.
  if (opts?.responsesLite === true) {
    applyCodexResponsesLiteShape(payload);
  }
  return payload;
}

// Responses Lite body shaping (mirrors reference applyCodexResponsesLiteShape).

function stripImageDetailsFromInput(
  input: Array<Record<string, unknown>>,
): void {
  for (const item of input) {
    // Reference strips pinned detail from both message `content` and tool
    // `output` collections (e.g. screenshots returned inside a tool result).
    for (const key of ["content", "output"] as const) {
      const collection = item[key];
      if (!Array.isArray(collection)) continue;
      for (const part of collection as Array<Record<string, unknown>>) {
        if (part["type"] === "input_image" && "detail" in part) {
          delete part["detail"];
        }
      }
    }
    if (item["type"] === "input_image" && "detail" in item) {
      delete item["detail"];
    }
  }
}

/**
 * Applies the Responses Lite body contract in place:
 * - strips image detail
 * - forces `parallel_tool_calls: false`
 * - hoists `tools` into a leading `{type:"additional_tools", role:"developer", tools:[...]}` item
 * - hoists `instructions` string into a developer message
 * - downgrades a hosted `tool_choice` to `"auto"` unless a matching declared tool is found
 * - deletes top-level `tools` / `instructions`
 */
export function applyCodexResponsesLiteShape(
  body: Record<string, unknown>,
): void {
  const input = Array.isArray(body["input"])
    ? (body["input"] as Array<Record<string, unknown>>)
    : [];
  stripImageDetailsFromInput(input);
  body["parallel_tool_calls"] = false;
  const declaredTools = Array.isArray(body["tools"])
    ? (body["tools"] as Array<Record<string, unknown>>)
    : [];
  let additionalTools = declaredTools;
  const toolChoice = body["tool_choice"];
  if (
    toolChoice !== null &&
    typeof toolChoice === "object" &&
    toolChoice !== undefined &&
    "type" in (toolChoice as Record<string, unknown>)
  ) {
    const choice = toolChoice as Record<string, unknown>;
    // Handle both `"function"` (reference) and `"tool"` (Cartethyia canonical)
    // selector types; canonical `ToolDefinition` may lack a `type` discriminator,
    // so match by `name` alone.
    if (choice["type"] === "computer") {
      const selected = declaredTools.find((tool) => {
        if (tool === null || typeof tool !== "object" || !("type" in tool))
          return false;
        return (tool as Record<string, unknown>)["type"] === "computer";
      });
      if (selected) {
        additionalTools = [selected];
        body["tool_choice"] = "required";
      }
    } else if (choice["type"] === "function" || choice["type"] === "tool") {
      const choiceName = choice["name"];
      if (typeof choiceName === "string") {
        const selected = declaredTools.find((tool) => {
          if (tool === null || typeof tool !== "object") return false;
          const t = tool as Record<string, unknown>;
          return "name" in t && t["name"] === choiceName;
        });
        if (selected) {
          additionalTools = [selected];
          body["tool_choice"] = "required";
        }
      }
    }
  }
  const prefix: Array<Record<string, unknown>> = [
    { type: "additional_tools", role: "developer", tools: additionalTools },
  ];
  if (
    typeof body["instructions"] === "string" &&
    (body["instructions"] as string).length > 0
  ) {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: body["instructions"] as string }],
    });
  }
  body["input"] = [...prefix, ...input];
  if (body["tool_choice"] !== "none" && body["tool_choice"] !== "required") {
    body["tool_choice"] = "auto";
  }
  delete body["instructions"];
  delete body["tools"];
}
