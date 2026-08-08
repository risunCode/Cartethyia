# Translation

## Overview

Cartethyia separates client surfaces from upstream protocols:

```text
client request → surface parser → canonical request → provider adapter
provider stream/response → canonical events → client surface encoder
```

The canonical layer carries messages, content blocks, tools, reasoning, usage, stop reasons, refusals, and images without binding the gateway to one vendor wire format.

## Request translation

- Chat Completions `messages` become canonical conversation messages.
- Responses `input` items become canonical content and tool items.
- Anthropic `system`, `messages`, and content blocks become canonical messages.
- Tool declarations become provider-neutral function tools.
- URLs, data URLs, and image content are normalized before dispatch.
- Reasoning configuration is normalized independently from the output surface.

Provider-specific headers, authentication, endpoints, and user agents belong to the adapter.

## Response translation

Provider output is decoded into canonical events or a final response before it is encoded for the client. An Anthropic upstream can therefore produce OpenAI Chat chunks, and an OpenAI-compatible upstream can produce Anthropic events when capability mapping permits it.

Preserved data includes text, reasoning, tool calls, tool results, usage, cached tokens, stop reasons, refusals, and images where representable. Malformed provider output becomes a bounded protocol error.

## Canonical stream events

Canonical events cover message start/stop, text deltas, reasoning deltas, tool-call start/delta/completion, tool results, usage, and errors. Decoders enforce line and aggregate byte limits and stop after terminal events. Encoders own target event names, framing, and terminators.

## Reasoning and thinking

Provider reasoning can arrive as explicit blocks, thinking deltas, or provider-specific fields. Decoders map it to canonical reasoning events; encoders emit the target surface's representation. Providers without a representable reasoning surface do not receive fabricated fields.

Reasoning is sensitive and follows console sanitization and retention rules.

## Tool-call translation

```text
client call → canonical call → provider-native call
provider result → canonical result → client-native result
```

Retain call ID, function name, argument fragments, and completion state. Concatenate streamed fragments before JSON validation. Provider-specific block/item mapping belongs in the codec, not the gateway.

## Usage and stop reasons

Usage is optional upstream data. Missing usage is not the same as zero usage. Stop reasons are normalized into completed, length, tool-call, refusal, provider-error, client-abort, and truncated-stream semantics when the source provides enough information.

## Image translation

URLs, data URLs, multipart files, and surface-specific content blocks are validated and normalized before adapter dispatch. Generation and editing are separate capabilities. Oversized or malformed image-edit payloads are rejected before network access.
