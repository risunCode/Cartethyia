# Tool calling

Implementation: `translate/concerns/tools.ts` (schema + argument
serialization), `translate/concerns/blocks.ts`
(`UnifiedToolCallBlock`/`UnifiedToolResultBlock`), `upstream/bridge.ts`
(streaming tool-call events).

## The three tool-definition shapes

| | tool definition | call (in a response) | result (sent back) |
|---|---|---|---|
| Anthropic | `tools[].{name, description, input_schema}` | `tool_use` block: `{id, name, input: object}` | `tool_result` block: `{tool_use_id, content}` |
| OpenAI Chat | `tools[].{type:"function", function:{name, description, parameters}}` (nested) | `message.tool_calls[].{id, type:"function", function:{name, arguments: STRING}}` | `role:"tool"` message: `{tool_call_id, content}` |
| OpenAI Responses | `tools[].{type:"function", name, description, parameters}` (flat) | output item: `{type:"function_call", call_id, name, arguments: STRING}` | input item: `{type:"function_call_output", call_id, output}` |

`tools.ts` converts every definition shape through `UnifiedToolDef {name,
description, schema}` — `anthropicToolToUnified`/`unifiedToolToAnthropic`,
`openAIChatToolToUnified`/`unifiedToolToOpenAIChat`,
`openAIResponsesToolToUnified`/`unifiedToolToOpenAIResponses`. The JSON Schema
itself (`input_schema` / `parameters`) is treated as shape-agnostic and
copied through unchanged — Anthropic and OpenAI both just want a JSON Schema
object, they don't disagree on ITS shape, only on where it's nested.

## The `arguments` string ⇄ `input` object mismatch

This is the #1 source of "tool call did nothing" bugs if a translator
forgets to handle it: **`arguments` is a JSON STRING on every OpenAI
surface, a native OBJECT (`input`) on Anthropic.**

Centralized in two functions everything else calls, never re-derives:

```ts
parseToolArguments(argumentsJson: string): Record<string, unknown>
stringifyToolArguments(input: Record<string, unknown>): string
```

`parseToolArguments` never throws — a model can legally emit malformed or
incomplete JSON mid-stream (see below), or a client can send garbage.
Unparsable input, or JSON that doesn't parse to a plain object (arrays and
primitives are explicitly rejected, not just "truthy typeof object") becomes
`{}` so every downstream consumer has a stable object to work with.

## Call-id correlation

Every surface's tool call carries a correlation id (Anthropic `tool_use.id`
== OpenAI `tool_calls[].id` / Responses `call_id`), unified as
`UnifiedToolCallBlock.id` / `UnifiedToolResultBlock.toolCallId`. This id is
what lets a tool RESULT (sent by the client in a follow-up turn) get matched
back to the CALL the assistant emitted — `denormalizeToOpenAIChatMessages`
emits one `role:"tool"` message per `UnifiedToolResultBlock`, keyed by
exactly this id, and the same pattern holds for Responses'
`function_call_output` items and Anthropic's `tool_result` blocks.

## Streaming tool calls

`upstream/bridge.ts`'s canonical `StreamEvent` union carries tool-call state
as four incremental events: `tool_call_start` (id + name), zero or more
`tool_call_args_delta` (raw JSON string fragment, NOT reparsed —
Anthropic's `input_json_delta` and OpenAI's `tool_calls[].function.arguments`
deltas are both partial-JSON streams already), and `tool_call_end`.

Two provider-specific quirks the decoders handle so the canonical stream
doesn't have to:

- **OpenAI Chat Completions omits `id` on every continuation chunk of a tool
  call** — only the first chunk carries it. `decodeOpenAIChatStream` tracks
  currently-open tool call ids in a `Set<string>` and keys continuation
  argument deltas off the most-recently-opened id (`[...openToolIds].at(-1)`).
- **Chat Completions has no per-tool-call end marker** — a tool call's end is
  implicit in the turn's `finish_reason`. `encodeOpenAIChatStream` is a
  no-op on `tool_call_end` and instead emits `finish_reason: "tool_calls"`
  once any tool call was opened during the turn, regardless of what
  Anthropic stop reason the canonical `finish` event actually carried
  (`anthropicStopToChatFinish(reason, hadToolCalls)` — tool calls always win).

On the encode side, `encodeAnthropicStream` and `encodeResponsesStream` open
a new content block / output item per `tool_call_start`, closing the
currently-open text block first if one was open (Anthropic content blocks
are strictly ordered and one-at-a-time; a tool call can't share an index
with the text that preceded it).

## `tool_choice`

Controls whether/which tool the model must call. All three surfaces express
the same four intents — auto (default), never call, must call SOME tool, or
must call this ONE named tool — with different vocabularies, handled by
four pairwise converters in `tools.ts`
(`openAIToolChoiceToAnthropic`/`anthropicToolChoiceToOpenAIChat`,
`openAIChatToolChoiceToResponses`/`responsesToolChoiceToOpenAIChat`):

| intent | Anthropic | OpenAI Chat | OpenAI Responses |
|---|---|---|---|
| auto (default) | `{type:"auto"}` / omitted | `"auto"` / omitted | `"auto"` / omitted |
| never call | `{type:"none"}` | `"none"` | `"none"` |
| must call some tool | `{type:"any"}` | `"required"` | `"required"` |
| must call this one | `{type:"tool", name}` | `{type:"function", function:{name}}` (nested) | `{type:"function", name}` (flat) |

Note Responses' named-function shape is FLAT (`{type:"function", name}`),
unlike Chat's nested `{type:"function", function:{name}}` — a client-visible
difference between the two OpenAI surfaces themselves, not just OpenAI vs.
Anthropic. Wired into all 4 request translators
(`openai-to-anthropic.ts`/`anthropic-to-openai.ts`/`openai-to-responses.ts`/`responses-to-openai.ts`);
`undefined`/`"auto"` are treated as equivalent and both denormalize to
"omit the field" so a round-trip never injects an explicit `tool_choice`
the client didn't send.

## `response_format` (OpenAI JSON mode) → Anthropic

Anthropic's Messages API has no grammar-enforced structured-output mode
reachable through this proxy, so `response_format` (OpenAI Chat only) is
folded into the Anthropic `system` prompt as a **best-effort instruction**
by `openai-anthropic.ts`'s private `responseFormatToSystemInstruction` —
appended after any client-supplied system message, before the cache
breakpoint pass runs (so caching still applies to the combined text). This
is NOT equivalent to OpenAI's `strict: true` JSON Schema mode: Claude can
still emit prose around/instead of the JSON. Do not tell clients this
guarantees parseable output the way OpenAI's structured outputs do.

## Two request-shape violations Anthropic rejects that OpenAI accepts

Anthropic validates two things server-side that an OpenAI-shape request can
violate without ever being invalid on ITS own terms — both handled by
`concerns/toolIntegrity.ts`, run right after normalize and before the cache
breakpoint pass, only on requests headed to an Anthropic upstream:

- **Missing tool results.** Every `tool_use` block in an assistant turn MUST
  be answered by a `tool_result` in the immediately following turn, or
  Anthropic 400s the ENTIRE request — a client sending hand-edited or
  history-cropped context (common in agentic loops) can omit one.
  `fixMissingToolResults` inserts an empty synthetic `tool_result` (a
  deliberate "this tool produced nothing" signal, never a lie about
  success) for any unanswered id. The synthetic result is MERGED into the
  front of the next message's blocks whenever that next message doesn't
  already start a fresh assistant turn — inserting it as a standalone
  message would itself produce two consecutive non-assistant turns, which
  trips Anthropic's separate "roles must alternate" 400.
- **Invalid tool-call ids.** `tool_use.id` (and the `tool_result.tool_use_id`
  referencing it) must match `^[a-zA-Z0-9_-]+$`; an id minted by a
  different OpenAI-compatible upstream can contain other characters (e.g.
  `+`/`/`/`=` from a base64 id). `sanitizeAnthropicToolIds` rewrites
  offending ids through ONE shared substitution map, so a `tool_call.id`
  and every `tool_result.toolCallId` referencing it get the SAME
  replacement — sanitizing only the call side independently (a naive
  per-block transform) breaks the correlation Anthropic uses to match a
  result back to its call, turning a fixable id into an orphaned
  reference. Already-valid ids are pre-scanned into the used-id set first
  so a generated replacement can never collide with an untouched id
  elsewhere in the same request.

## `is_error` on tool results (Anthropic → OpenAI)

Anthropic's `tool_result` blocks carry an `is_error` flag the model should
treat as "this call failed", but OpenAI Chat's `role:"tool"` message has no
equivalent field. `denormalizeToOpenAIChatMessages` preserves the signal by
prefixing the content with `[tool_error] ` instead of silently dropping the
flag — the model still needs to know the call failed even through a
shape that has no dedicated slot for saying so.

## `max_tokens` floor when tools are present

A client that didn't override the default `max_tokens` (or set a small one)
risks having a tool call's `arguments` JSON truncated mid-stream by
Anthropic — the emitted JSON becomes unparsable and unrecoverable, unlike a
truncated text answer which just reads as cut off.
`translateChatRequestToAnthropic` floors `max_tokens` to `4096`
(`MIN_TOKENS_FOR_TOOL_CALLING`) whenever the request has `tools`, taking the
larger of the client's requested value and the floor — a client that
explicitly asked for MORE than 4096 is never reduced.
