# API

## Base URL and authentication

The default base URL is `http://localhost:12800`. Proxy routes use either:

```http
Authorization: Bearer CARTETHYIA_API_KEY
```

or:

```http
x-api-key: CARTETHYIA_API_KEY
```

Console sessions are separate from proxy API-key authentication.

## Route overview

| Method | Route | Surface |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/images/generations` | OpenAI-compatible images |
| `POST` | `/v1/images/edits` | OpenAI-compatible image edits |
| `QUERY` | `/v1/models` | Authenticated model catalog; `GET` is translated by the unified HTTP boundary |
| `GET` | `/health` | Public process liveness |

The client surface does not determine the upstream protocol. Native OpenAI
models use the Responses API by default; Chat-compatible requests are
translated to Responses and translated back at the client boundary. Other
OpenAI-compatible providers may still expose Chat Completions natively.
Routing and adapters translate between client and provider surfaces.

## Chat Completions

`POST /v1/chat/completions` accepts OpenAI messages, `stream`, reasoning
configuration, tools, tool results, and multimodal content where the selected
adapter supports them.

Chat reasoning uses the OpenAI Chat-compatible `reasoning_effort` field (or
the proxy's `reasoning.effort`/`reasoning.summary` form). Responses-only
`reasoning.mode` and `reasoning.context` are rejected on this surface instead
of being silently dropped.

```json
{
  "model": "openai/gpt-5.6",
  "messages": [{"role":"user","content":"Hello"}],
  "reasoning_effort": "high",
  "stream": false
}
```

## Responses

`POST /v1/responses` accepts Responses input and output-item semantics:

```json
{
  "model": "openai/gpt-5.6",
  "input": [{"role":"user","content":[{"type":"input_text","text":"Hello"}]}],
  "reasoning": {
    "summary": "concise",
    "mode": "standard",
    "context": "all_turns"
  },
  "include": ["reasoning.encrypted_content"],
  "stream": true
}
```

Supported reasoning controls are `effort` (`xhigh`, `high`, `medium`, `low`,
`minimal`, `none`), `summary` (`auto`, `concise`, `detailed`), `mode`
(`standard`, `pro`), and `context` (`auto`, `current_turn`, `all_turns`).
Reasoning output items are retained in input history, including bounded
`id`, `summary`, and `encrypted_content` fields, and assistant message
`phase` (`commentary` or `final_answer`) is round-tripped.
When reasoning is enabled without an explicit `summary`, the proxy sends
`summary: "concise"` by default to keep terminal output short. Clients may
request `auto` or `detailed` explicitly.

Input items, reasoning items, tool calls, tool outputs, usage, and terminal events are normalized according to the target capabilities.

## Anthropic Messages

`POST /v1/messages` accepts `system`, `messages`, content blocks, `max_tokens`, tools, thinking, and streaming where supported:

```json
{
  "model": "claude-sonnet-4",
  "max_tokens": 1024,
  "messages": [{"role":"user","content":"Hello"}],
  "stream": true
}
```

## Images

`POST /v1/images/generations` handles OpenAI-compatible image generation. `POST /v1/images/edits` accepts bounded multipart or supported JSON image-edit input. Image capability is checked before dispatch; text generation is not used as a silent fallback.

## Models

`QUERY /v1/models` returns the routeable model catalog visible to the API key. `GET /v1/models` is a compatibility alias translated at the gateway boundary. Entries can be direct models, aliases, or combos. Provider/model ACLs apply before the catalog is returned.

## Streaming

Set `stream:true` to receive the requested surface's SSE events. Provider chunks are decoded into canonical events and re-encoded for the client. Clients must handle incremental text, reasoning, tool arguments, terminal events, provider errors, and incomplete disconnects.

## Tool calling

The round trip is:

```text
client tools → canonical tool call → provider call → canonical tool result → client result
```

Preserve tool-call IDs, names, and argument JSON. Accumulate streamed argument fragments before execution and never execute malformed or incomplete arguments. Return the tool result using the original surface's role/item shape.

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, body shape, route input, or body limit violation |
| `401` | Missing or invalid API authentication |
| `403` | API-key ACL rejection |
| `404` | Unknown route or asset |
| `413` | Oversized request or image-edit payload |
| `429` | Admission, rate, concurrency, quota, account, or provider capacity rejection |
| `5xx` | Internal, provider, transport, or translation failure |

Errors are bounded and sanitized. They must not expose tokens, credentials, filesystem paths, or upstream secrets.

## Health

`GET /health` is unauthenticated and cheap. It returns HTTP 200 while the single server process is serving.
