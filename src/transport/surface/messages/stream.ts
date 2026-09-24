import type { CanonicalEvent, UsageRecord } from "../../canonical-model";
import { SurfaceStreamEncoder } from "../stream-base";
import {
  createToolCallTracker,
  resetToolCallTracker,
  toolIdentityKey,
  trackToolCall,
} from "../../tool-identity";
import type { MessagesEncodingContext, MessagesStreamEvent } from "./parse";
import {
  blockFromPart,
  mapStopReason,
  requireMessagesToolName,
} from "./encode";
import { usageToMessagesWire } from "../../../providers/usage";
import type { ToolCallState } from "../../tool-identity";
/**
 * Incremental streaming encoder for Anthropic Messages.
 * Emits `message_start` on first event and then translates each
 * `CanonicalEvent` into zero or more `MessagesStreamEvent`s without
 * buffering the full upstream response.
 */
export class MessagesStreamEncoder extends SurfaceStreamEncoder<CanonicalEvent, MessagesStreamEvent> {
  private started = false;
  private finished = false;
  private nextIndex = 0;
  private openBlock: { type: string; index: number } | undefined;
  private openReasoningSummaryIndex: number | undefined;
  // Tool index pinning + arguments accumulation via the shared tracker
  // (transport/tool-identity.ts). `nextIndex` stays ledger-global (text and
  // tool blocks share one numbering) and is passed as the tracker's
  // fallback for unseen ids.
  private tools = createToolCallTracker();
  // Provider spellings of one call id (`call_X` vs `fc_X`) must reach the
  // client once, so every per-call map below is keyed by `toolIdentityKey`
  // rather than the raw wire id. This map remembers the first spelling seen
  // for an identity, because that is the id the client is handed.
  private wireIds = new Map<string, string>();
  // Call ids whose `tool_use` block has already been opened on the wire.
  // Tracked separately from `tools.indexById` because the shared tracker
  // assigns an index on first sighting, so the index map cannot tell "block
  // not opened yet" from "block already open".
  private openedToolCalls = new Set<string>();
  // Arguments already sent per call id. A provider may stream argument
  // fragments before it supplies the tool name, and a `tool_use` block cannot
  // be opened without one — so fragments are withheld until the name arrives
  // and then emitted as the difference, rather than opening the block under a
  // fabricated name (see `requireMessagesToolName`).
  private emittedArguments = new Map<string, number>();
  // Calls dropped at a final flush because the upstream never named them.
  // Dropping beats discarding the response; the count feeds the stop-reason
  // downgrade and the dispatch-level warning.
  private droppedUnnamedToolCalls = 0;
  private usage: UsageRecord | undefined;
  private failed = false;
  private stopReason: string | null = null;
  private readonly responseId: string;
  private readonly model: string;

  constructor(ctx: MessagesEncodingContext = {}) {
    super();
    this.responseId = ctx.response_id ?? `msg-${crypto.randomUUID()}`;
    this.model = ctx.model ?? "unknown";
  }

  /**
   * Identity key for a call id, remembering the first spelling seen.
   *
   * A backend may deliver one call under two ids that differ only by prefix;
   * keying every per-call map by identity collapses them into one block, and
   * the client is handed the first spelling so the id it replays upstream is
   * one the backend actually sent.
   */
  private keyFor(callId: string): string {
    const key = toolIdentityKey(callId);
    if (!this.wireIds.has(key)) this.wireIds.set(key, callId);
    return key;
  }

  /**
   * Emits a call's `tool_use` block and whatever arguments have not been sent
   * yet. Requires a real name: opening the block under a placeholder would
   * make the client reject the call as an unknown tool.
   */
  private emitToolCall(callId: string, entry: ToolCallState): MessagesStreamEvent[] {
    const out: MessagesStreamEvent[] = [];
    const name = requireMessagesToolName(entry.name, callId);
    const existing = this.tools.indexById.get(callId);
    const index = existing ?? this.nextIndex++;
    this.tools.indexById.set(callId, index);
    const sent = this.emittedArguments.get(callId) ?? 0;
    const pending = entry.arguments.slice(sent);
    if (!this.openedToolCalls.has(callId)) {
      this.openedToolCalls.add(callId);
      out.push(...this.closeOpenBlock());
      out.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: this.wireIds.get(callId) ?? callId, name, input: {} },
      });
      this.openBlock = { type: "tool_use", index };
    } else if (pending.length > 0 && this.openBlock?.index !== index) {
      // Interleaved parallel calls: resume this one's block. Re-arming is
      // gated on there being a fragment to write — an already-emitted call
      // re-visited with nothing left to send would otherwise leave an empty
      // block open for the next `closeOpenBlock()` to stop a second time.
      out.push(...this.closeOpenBlock());
      this.openBlock = { type: "tool_use", index };
    }
    if (pending.length > 0) {
      out.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: pending },
      });
      this.emittedArguments.set(callId, entry.arguments.length);
    }
    return out;
  }

  /**
   * Emits every tracked call that has a name, parking the rest.
   *
   * `final` distinguishes the two callers: mid-stream (a tool result arrived)
   * an unnamed call is still parked, because its name may yet come; at the end
   * of the stream it can never be expressed on the Messages wire
   * (`tool_use.name` is mandatory and a placeholder would surface as an
   * "unknown tool" client rejection). A final unnamed call is therefore
   * dropped and counted — the caller downgrades `tool_use` to `end_turn` so
   * the client sees a coherent turn instead of a dangling tool_use stop with
   * no call. Killing the whole stream (a prior design) traded a
   * recoverable omission for a 500.
   */
  private flushToolCalls(final = false): MessagesStreamEvent[] {
    const out: MessagesStreamEvent[] = [];
    for (const [callId, entry] of this.tools.states) {
      const named = entry.name !== undefined && entry.name.trim().length > 0;
      if (!named) {
        if (final) this.droppedUnnamedToolCalls += 1;
        continue;
      }
      out.push(...this.emitToolCall(callId, entry));
    }
    return out;
  }

  /**
   * Closes the currently open block, if any.
   *
   * A method rather than an inline `if (this.openBlock)` because the emitters
   * above open blocks too: TypeScript narrows a field to `undefined` after an
   * inline check and cannot see the intervening helper reassign it, which
   * turns the next read into `never`.
   */
  private closeOpenBlock(): MessagesStreamEvent[] {
    const block = this.openBlock;
    if (block === undefined) return [];
    this.openBlock = undefined;
    return [{ type: "content_block_stop", index: block.index }];
  }
  push(event: CanonicalEvent): MessagesStreamEvent[] {
    if (this.finished) throw new Error("Messages stream has more than one terminal event");
    const out: MessagesStreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({
        type: "message_start",
        message: {
          id: this.responseId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return out;
    }
    if (event.type === "keepalive") {
      return out;
    }
    if (event.type === "error") {
      // Non-terminal: remember the failure and let the terminal event close
      // the stream exactly once. Emitting message_stop here would make the
      // inevitable terminal push throw, producing a second error frame
      // after message_stop (which Anthropic never sends).
      this.failed = true;
      return out;
    }
    if (event.type === "content_delta") {
      const part = event.content;
      if (part.kind === "text") {
        // Empty deltas carry no visible content and must not open or emit a
        // new block.
        if (part.text.length === 0) return out;
        // An empty delta carries nothing to render. Opening a block for it
        // fragmented one answer into alternating empty text/thinking blocks
        // (parsers now drop these too; this is the last gate before the wire).
        if (this.openBlock?.type !== "text") {
          if (this.openBlock) out.push({ type: "content_block_stop", index: this.openBlock.index });
          const idx = this.nextIndex++;
          out.push({
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          });
          this.openBlock = { type: "text", index: idx };
          this.openReasoningSummaryIndex = undefined;
        }
        out.push({
          type: "content_block_delta",
          index: this.openBlock.index,
          delta: { type: "text_delta", text: part.text },
        });
        return out;
      }
      if (part.kind === "reasoning") {
        const isRedacted = part.opaque === true;
        const summary =
          typeof part.summary === "string"
            ? part.summary
            : typeof part.payload === "string"
              ? part.payload
              : "";
        const signature = typeof part.signature === "string" ? part.signature : "";
        // Nothing to render: an empty thinking delta must not open a block
        // (same fragmentation as the empty-text case above).
        if (!isRedacted && summary.length === 0 && signature.length === 0) return out;
        const blockType = isRedacted ? "redacted_thinking" : "thinking";
        const summaryIndex = part.summary_index;
        if (
          blockType === "thinking" &&
          this.openBlock?.type === blockType &&
          summaryIndex !== undefined &&
          this.openReasoningSummaryIndex !== undefined &&
          summaryIndex !== this.openReasoningSummaryIndex
        ) {
          out.push({ type: "content_block_stop", index: this.openBlock.index });
          this.openBlock = undefined;
        }
        if (this.openBlock?.type !== blockType) {
          if (this.openBlock) out.push({ type: "content_block_stop", index: this.openBlock.index });
          const idx = this.nextIndex++;
          const initial = isRedacted
            ? { type: "redacted_thinking" }
            : { type: "thinking", thinking: "" };
          out.push({ type: "content_block_start", index: idx, content_block: initial });
          this.openBlock = { type: blockType, index: idx };
          this.openReasoningSummaryIndex = summaryIndex;
        }
        if (isRedacted) {
          out.push({
            type: "content_block_delta",
            index: this.openBlock.index,
            delta: { type: "redacted_thinking_delta", data: part.payload ?? part },
          });
        } else {
          if (summary.length > 0)
            out.push({
              type: "content_block_delta",
              index: this.openBlock.index,
              delta: { type: "thinking_delta", thinking: summary },
            });
          if (signature.length > 0) {
            out.push({
              type: "content_block_delta",
              index: this.openBlock.index,
              delta: { type: "signature_delta", signature },
            });
          }
        }
        return out;
      }
      if (part.kind === "image") {
        if (this.openBlock) {
          out.push({ type: "content_block_stop", index: this.openBlock.index });
          this.openBlock = undefined;
        }
        const idx = this.nextIndex++;
        out.push({
          type: "content_block_start",
          index: idx,
          content_block: { type: "image", source: part.payload },
        });
        out.push({
          type: "content_block_delta",
          index: idx,
          delta: { type: "image_delta", data: part.payload },
        });
        out.push({ type: "content_block_stop", index: idx });
        return out;
      }
      if (part.kind === "toolResult") {
        // Close any open tool block, then flush every call that has a name so
        // its arguments reach the client before the result that answers it.
        out.push(...this.closeOpenBlock());
        out.push(...this.flushToolCalls());
        out.push(...this.closeOpenBlock());
        this.tools.states.clear();
        this.emittedArguments.clear();
        this.openedToolCalls.clear();
        this.wireIds.clear();
        const resultBlock = blockFromPart({
          kind: "toolResult",
          call_id: part.call_id,
          content: part.content,
        });
        // A toolResult part always materializes; the guard is for the type
        // system (blockFromPart is undefined only for foreign extensions).
        if (resultBlock === undefined) return out;
        const idx = this.nextIndex++;
        out.push({ type: "content_block_start", index: idx, content_block: resultBlock });
        out.push({
          type: "content_block_delta",
          index: idx,
          delta: { type: "tool_result_delta", data: resultBlock },
        });
        out.push({ type: "content_block_stop", index: idx });
        return out;
      }
      if (this.openBlock) {
        out.push({ type: "content_block_stop", index: this.openBlock.index });
        this.openBlock = undefined;
      }
      // Foreign extensions degrade away: no Messages block exists for them.
      const block = blockFromPart(part);
      if (block === undefined) return out;
      const idx = this.nextIndex++;
      out.push({ type: "content_block_start", index: idx, content_block: block });
      out.push({
        type: "content_block_delta",
        index: idx,
        delta: { type: `${String(block.type)}_delta`, data: block },
      });
      out.push({ type: "content_block_stop", index: idx });
      return out;
    }
    if (event.type === "tool_call_delta") {
      // Tracked under the identity key, not the raw id: the second spelling of
      // a call then joins the first instead of opening a second block.
      const callKey = this.keyFor(event.call_id);
      const tracked = trackToolCall(
        this.tools,
        { id: callKey, name: event.name, args: event.arguments_delta },
        this.nextIndex,
      );
      this.nextIndex = Math.max(this.nextIndex, tracked.index + 1);
      // Withhold until the name is known: a `tool_use` block cannot be opened
      // without a real name, and the fragments are kept by the tracker so they
      // are emitted intact once it arrives.
      if (tracked.state.name === undefined || tracked.state.name.trim().length === 0) return out;
      out.push(...this.emitToolCall(callKey, tracked.state));
      return out;
    }
    if (event.type === "terminal") {
      this.failed = this.failed || event.state === "failed";
      this.stopReason =
        event.stop_reason !== undefined
          ? mapStopReason(event.stop_reason)
          : event.state === "complete"
            ? "end_turn"
            : null;
      if (event.usage !== undefined) this.usage = event.usage;
      out.push(...this.closeOpenBlock());
      // Final flush: every tracked call still owed a block gets one, then the
      // block closes. A call the upstream never named is dropped (counted in
      // `droppedUnnamedToolCalls`): an inexpressible tool_use must not void
      // the whole turn, but a `tool_use` stop with no call is a client-side
      // protocol error, so the stop reason downgrades to `end_turn`.
      out.push(...this.flushToolCalls(true));
      out.push(...this.closeOpenBlock());
      // Downgrade only when the drop left no `tool_use` block on the wire: a
      // surviving named call keeps `tool_use` accurate, while a bare
      // `tool_use` stop with zero calls is a dangling stop the client cannot
      // act on. Checked before `openedToolCalls` is cleared.
      if (this.droppedUnnamedToolCalls > 0 && this.openedToolCalls.size === 0 && this.stopReason === "tool_use")
        this.stopReason = "end_turn";
      this.emittedArguments.clear();
      this.openedToolCalls.clear();
      this.wireIds.clear();
      resetToolCallTracker(this.tools);
      const finalUsage = usageToMessagesWire(this.usage);
      if (this.failed) {
        out.push({
          type: "message_delta",
          delta: { stop_reason: null, stop_sequence: null },
          usage: finalUsage,
        });
      } else {
        out.push({
          type: "message_delta",
          delta: { stop_reason: this.stopReason, stop_sequence: null },
          usage: finalUsage,
        });
      }
      out.push({ type: "message_stop" });
      this.finished = true;
      return out;
    }
    return out;
  }

  finish(): MessagesStreamEvent[] {
    if (!this.started) {
      this.started = true;
      return [
        {
          type: "message_start",
          message: {
            id: this.responseId,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: this.stopReason, stop_sequence: null },
          usage: usageToMessagesWire(this.usage),
        },
        { type: "message_stop" },
      ];
    }
    if (this.finished) return [];
    const out: MessagesStreamEvent[] = [];
    out.push(...this.closeOpenBlock());
    out.push(...this.flushToolCalls(true));
    out.push(...this.closeOpenBlock());
    // Same downgrade rule as the terminal path: only when no named call
    // survived. Checked before `openedToolCalls` is cleared.
    if (this.droppedUnnamedToolCalls > 0 && this.openedToolCalls.size === 0 && this.stopReason === "tool_use")
      this.stopReason = "end_turn";
    this.emittedArguments.clear();
    this.openedToolCalls.clear();
    this.wireIds.clear();
    resetToolCallTracker(this.tools);
    out.push({
      type: "message_delta",
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: usageToMessagesWire(this.usage),
    });
    out.push({ type: "message_stop" });
    this.finished = true;
    return out;
  }
}
