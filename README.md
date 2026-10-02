# ![](orca-paste-1790786723417-099ae9d3-f3a2-4dac-9c24-74887febf6fa.png) Cartethyia

<img width="1760" height="576" alt="Cartethyia banner" src="https://github.com/user-attachments/assets/666f3a3d-136e-49d7-8bec-ff967f93b78f" />

**One friendly gateway for all your AI providers.**

Cartethyia lets you connect several AI providers behind one endpoint. Set up your
provider accounts once, create an API key, and point OpenCode, Droid, Cline, Claude
Code, Codex, or any other client that speaks an OpenAI- or Anthropic-compatible API
at Cartethyia.

It takes care of routing, provider health, retries, model capabilities, usage, and
optional proxy pools. Your client sends a request in the format it already knows;
Cartethyia picks a usable account, translates the request when needed, and sends the
response back in the format your client expects.

Built with Bun, TypeScript, Elysia, PostgreSQL, and optional Redis coordination.

## Supported client routes

| Route | What it is for |
|---|---|
| `/v1/chat/completions` | OpenAI-style chat requests |
| `/v1/responses` | Responses API requests, including Codex-style tools and reasoning |
| `/v1/responses/compact` | Responses compaction |
| `/v1/messages` | Anthropic Messages requests, including Claude Code |
| `/v1/completions` | Legacy text completions |
| `/v1/models` | List available models |
| `/v1/search` | Web search |
| `/v1/systemone` | System One decision requests |

The client protocol belongs to the connection, not to the route you configure. Once a
request is normalized, the same routing, admission, retry, accounting, and telemetry
rules apply across the supported surfaces.

## Why Cartethyia?

| Cartethyia | Why people like it |
|---|---|
| **One endpoint for every AI tool** | OpenCode, Droid, Cline, Claude Code, Codex, and any OpenAI/Anthropic-compatible client |
| **Powerful routing** | Route by model, alias, capability, account health, cooldown, quota, and provider availability |
| **Fast request path** | Bun-powered, streaming-first, and built for low-overhead routing |
| **Provider-aware** | Each provider keeps its own auth, headers, endpoint, quota, and streaming behavior |
| **Clear debugging** | Inspect Client Request → Provider Request → Provider Response → Client Response |
| **Honest health status** | Healthy, cooldown, cooling, exhausted, and disabled stay separate |
| **Full control** | Own your keys, routes, proxy pools, quotas, telemetry, and backups |
| **Self-hosted** | Run locally, with Docker, or as a standalone binary |

### Why migrate?

A simple router can handle fallback. Cartethyia gives you control over the entire gateway:

- smarter routing;
- clearer provider behavior;
- better request visibility;
- accurate health tracking;
- configurable proxy and security policies;
- one gateway for your complete AI workflow.

> **One endpoint. Any client. Any provider. Full control.**

## Getting started

Want to run Cartethyia locally? See the [Getting started guide](documentation/getting-started.md)
for requirements, PostgreSQL setup, local in-memory Redis mode, Docker, commands,
and verification steps.

For contribution rules and repository workflow, see `CONTRIBUTING.md`.

## License

Cartethyia is licensed under the **GNU General Public License v3.0 only**.
See [`LICENSE`](LICENSE) for the complete terms.

You may use, copy, modify, and share this software under GPLv3. If you distribute
Cartethyia or a modified version, you must keep the license and copyright notices,
provide the corresponding source code, and license the covered work under GPLv3.
You may not add restrictions that remove the freedoms granted by the license.

This software is provided **without warranty**. It is distributed in the hope that
it will be useful, but there is no guarantee that it is fit for a particular purpose,
secure, available, or free from defects. See the warranty disclaimer and limitation
of liability in `LICENSE`.
