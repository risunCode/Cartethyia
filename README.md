# Cartethyia

Cartethyia is a Bun + Elysia AI proxy with an authenticated console. It exposes OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages while routing models to managed provider accounts, custom compatible providers, aliases, and combos.

**Current release: `1.0.0-alpha`** — feature-complete alpha for local and self-hosted testing. Review the [changelog](./CHANGELOG.md) for the release scope and known alpha-level caveats.

## Features

- OpenAI / Anthropic request and streaming translation.
- Built-in providers: OpenCode Free, OpenCode Zen, Command Code, Kimchi, Devin, Qoder, Cursor, OpenAI, Anthropic, Xiaomi MiMo PAYG, OpenRouter, Ollama, Cerebras, DeepSeek, SiliconFlow, Mistral, and OpenCode Go.
- Console-managed encrypted credentials with priority or round-robin routing, cooldowns, and per-connection testing.
- Batch account entry: paste API keys, PATs, or session tokens one per line.
- Live console log, in-memory usage dashboard, and JSONL runtime request/error logs under `DATA_DIR/logs`.
- Custom OpenAI-compatible and Anthropic-compatible upstreams.

## Quick start

```bash
bun install
cd dashboard && bun install && cd ..
cp .env.example .env
bun run dev
```

Open `http://localhost:12800/console` and set up the console. Check health:

```bash
curl http://localhost:12800/health
```

## API

| Route | Shape |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` | Anthropic Messages |
| `GET /v1/models` | Unified model list |
| `GET /health` | Liveness probe |
| `GET /console` | Management console |

Use the proxy API key created in the console:

```bash
curl http://localhost:12800/v1/chat/completions \
  -H "content-type: application/json" \
  -H "authorization: Bearer $CARTETHYIA_API_KEY" \
  -d '{"model":"foc/big-pickle","messages":[{"role":"user","content":"Hello"}]}'
```

## Qualified provider prefixes

| Provider | Prefix |
| --- | --- |
| OpenCode Free | `foc/` |
| OpenCode Zen | `opencodezen/` |
| Command Code | `cmd/` |
| Kimchi | `kimchi/` |
| Devin | `devin/` |
| Qoder | `qoder/` |
| Cursor | `cursor/` |
| OpenAI | `openai/` |
| Anthropic | `anthropic/` |
| Xiaomi MiMo PAYG | `pmimo/` |
| OpenRouter | `openrouter/` |
| Ollama | `ollama/` |
| Cerebras | `cerebras/` |
| DeepSeek | `deepseek/` |
| SiliconFlow | `siliconflow/` |
| Mistral | `mistral/` |
| OpenCode Go | `opencodego/` |
| Custom compatible provider | `<its own slug>/` — no `custom/` wrapper, e.g. `awok/gpt-4o-mini` |

## Configuration

Copy `.env.example` for local development. For production, configure secrets in the platform instead of committing an `.env` file.

| Variable | Required in production | Purpose |
| --- | --- | --- |
| `PORT` | Platform-provided | HTTP listener; Railway injects this automatically. |
| `DATA_DIR` | Yes | Persistent data directory; use `/app/data` on Railway. |
| `CONSOLE_PASSWORD` | Yes | Console login password. |
| `CONSOLE_JWT_SECRET` | Yes | Long random secret for console sessions. |
| `CREDENTIAL_ENCRYPTION_KEY` | Recommended | Base64/hex secret for encrypted provider credentials. If omitted, a key file is stored in `DATA_DIR`. |
| `BOOTSTRAP_PROXY_API_KEY` | Recommended | Optional first proxy API key. |
| `MAX_FLIGHTS_PER_IP` | No | Per-IP concurrent request limit; defaults to `20`. |
| `TRUST_PROXY` | Railway | Set `true` when Railway is the trusted reverse proxy. |
| `OPENCODE_FREE_ACCESS` | No | `all`, `local`, or `none`; defaults to `all`. |

## Railway deployment

1. Push this repository to GitHub and create a Railway service from it. Railway detects `railway.toml` and builds `Dockerfile`.
2. Create a Railway **Volume** and mount it at **`/app/data`**. The volume is required for console configuration, encrypted provider credentials, logs, and the credential key file to survive redeployments.
3. Add Railway variables:
   ```text
   DATA_DIR=/app/data
   CONSOLE_PASSWORD=<strong unique password>
   CONSOLE_JWT_SECRET=<long random secret>
   CREDENTIAL_ENCRYPTION_KEY=<long random secret>
   TRUST_PROXY=true
   ```
   Railway sets `PORT`; do not hard-code it.
4. Because Railway volumes are mounted as root, set `RAILWAY_RUN_UID=0` for this service so the mounted `/app/data` stays writable. The application itself has no shell or package manager in its runtime workflow.
5. Deploy and confirm Railway health checks `GET /health` successfully. Then open `/console`, create a proxy API key, and add provider accounts.

Railway volume attachment is configured in the Railway UI/CLI, not in `railway.toml`; the config file supplies the Docker build, health check, and restart policy.

### Local Docker smoke test

```bash
docker build -t cartethyia .
docker run --rm -p 12800:8080 \
  -e PORT=8080 \
  -e DATA_DIR=/app/data \
  -e CONSOLE_PASSWORD=change-me \
  -e CONSOLE_JWT_SECRET=replace-with-a-long-random-secret \
  -v cartethyia-data:/app/data \
  cartethyia
```

## Development and verification

```bash
bun test
bunx tsc --noEmit -p .
cd dashboard && bun run build
```

## Architecture

- `src/routes/` — public API handlers.
- `src/routing/` — provider-prefix, alias, combo, and filter resolution.
- `src/upstream/` — provider adapters, retry logic, stream bridge, and request transforms.
- `src/console/` — authenticated console API, encrypted account storage, runtime tracking, and SPA serving.
- `dashboard/` — React/Vite management console.
- `data/` — runtime state; mount this directory in production and never commit it.

See [`docs/FORMATS.md`](./docs/FORMATS.md), [`docs/TOOL_CALLING.md`](./docs/TOOL_CALLING.md), and [`docs/CACHING.md`](./docs/CACHING.md) for protocol details.
