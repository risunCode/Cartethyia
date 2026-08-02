<img width="1760" height="576" alt="image (1)" src="https://github.com/user-attachments/assets/b4251752-bae0-4ac5-9c26-bdedfc7c3431" />


Cartethyia is a Bun + Elysia AI proxy with a public landing page and an authenticated console. It translates OpenAI Chat/Responses and Anthropic Messages requests while routing models across provider accounts, aliases, combos, and custom compatible endpoints.

## Community

> **[Cartethyia Home Discord ]**  

Community access is free. Join Discord: <https://discord.gg/zFcNPJM6qM>

### ShowCase

<div align="center">
<img src="https://github.com/user-attachments/assets/56427fc5-ab50-44f0-9cb1-ee368d21b85c" width="32%" />
<img src="https://github.com/user-attachments/assets/39f73c4e-f136-419e-bc4b-ef9437af4fc9" width="32%" />
<img src="https://github.com/user-attachments/assets/c8496545-b5c3-4e2a-90b7-a8ea9f18b355" width="32%" />
</div>

## Features

- OpenAI Chat Completions, Responses, and Anthropic Messages.
- Provider routing with priority, round-robin, cooldowns, aliases, combos, and failover.
- Provider accounts, API keys, model ACLs, usage limits, logs, and request history.
- Model Studio with persistent history, edit/copy/delete actions, token usage, and compaction.
- Custom OpenAI-compatible and Anthropic-compatible upstreams.
- Responsive Cartethyia public landing page at `/`.

## Quick start

```bash
bun install
cd dashboard && bun install && cd ..
cp .env.example .env
bun run dev
```

Open:

- Public page: <http://localhost:12800/>
- Console: <http://localhost:12800/console/>
- Health: <http://localhost:12800/health>

## API

| Route | Protocol |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` | Anthropic Messages |
| `GET /v1/models` | Unified provider/model catalog |
| `GET /health` | Liveness probe |

Create a proxy API key from **Console → API Keys**. Keys can restrict providers/models and enforce request, concurrency, and token limits.

```bash
curl http://localhost:12800/v1/models \
  -H "authorization: Bearer $CARTETHYIA_API_KEY"
```

## Configuration

Copy `.env.example` for local development. In production, set secrets in the platform and mount `DATA_DIR` as persistent storage.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listener; Railway supplies this automatically. |
| `DATA_DIR` | Persistent configuration, logs, and runtime state. |
| `CONSOLE_PASSWORD` | Console login password. |
| `CONSOLE_JWT_SECRET` | Secret used to sign console sessions. |
| `PROXY_AUTH_MODE` | `open` or `api_key`. |
| `CONSOLE_SESSION_TTL_HOURS` | Console session lifetime; defaults to `12`. |
| `TRACK_PAYLOADS` | Request/response tracking level: `none` or `meta`. |
| `TRACK_ASSETS` | Asset tracking level: `none`, `meta`, or `store`. |

## Docker / Railway

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

For Railway, mount a volume at `/app/data`, configure `CONSOLE_PASSWORD`, `CONSOLE_JWT_SECRET`, and `TRUST_PROXY=true`, then verify `GET /health` after deployment.


## Development

```bash
bunx tsc --noEmit -p .
bun test test/
cd dashboard && bun run test && bun run build
```

See the protocol notes in [`docs/`](./docs/) and the landing mockup in [`docs/landing-page-mockup.md`](./docs/landing-page-mockup.md).
