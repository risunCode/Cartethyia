# Getting Started

## Requirements

- Bun 1.4-canary (low-memory)
- A writable `DATA_DIR`
- A provider credential or API key
- Optional Docker or Railway deployment

## Installation

```bash
bun install
cd dashboard
bun install
cd ..
cp .env.example .env
```

Set `CONSOLE_PASSWORD`, `CONSOLE_JWT_SECRET`, and `BOOTSTRAP_PROXY_API_KEY` in `.env` for a usable local instance:

```bash
bun run dev
```

Open `http://localhost:12800/console/login`. Liveness is available at `http://localhost:12800/health`.

## Configuration

Use [`.env.example`](../.env.example) as the authoritative variable list.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listen port; defaults to `12800`. |
| `DATA_DIR` | Persistent root for configuration, runtime data, and assets. |
| `CONSOLE_PASSWORD` | Password for the web console. |
| `CONSOLE_JWT_SECRET` | Secret used to sign console sessions. |
| `BOOTSTRAP_PROXY_API_KEY` | Initial API key for proxy traffic. |
| `DB_PATH` | Optional configuration database override. |
| `RUNTIME_DB_PATH` | Optional runtime database override. |

Persist `DATA_DIR` across restarts. Store secrets in a platform secret manager, never in source control or image layers.

Optional Headroom settings are controlled by `CARTETHYIA_HEADROOM_ENABLED`, `CARTETHYIA_HEADROOM_URL`, and `CARTETHYIA_HEADROOM_TIMEOUT_MS`. Long user messages are compressed automatically when Headroom is available.

## Your first request

```bash
export CARTETHYIA_URL=http://localhost:12800
export CARTETHYIA_API_KEY=replace-me

curl "$CARTETHYIA_URL/v1/chat/completions" \
  -H "Authorization: Bearer $CARTETHYIA_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Hello from Cartethyia"}]}'
```

On Windows PowerShell:

```powershell
$env:CARTETHYIA_URL = "http://localhost:12800"
$env:CARTETHYIA_API_KEY = "replace-me"
```

The model may be a direct provider model, alias, or combo configured in the console. Add `"stream":true` for SSE output.

## Production build

```bash
bun run build
cd dashboard && bun run build
```

The server binary is written to `bin/cartethyia` or `bin/cartethyia.exe` on Windows. The dashboard is generated under `dashboard/dist/`.

## Docker

```bash
docker build -t cartethyia .
docker run --rm -p 12800:8080 \
  -e PORT=8080 -e DATA_DIR=/app/data \
  -e CONSOLE_PASSWORD=change-me \
  -e CONSOLE_JWT_SECRET=replace-me \
  -e BOOTSTRAP_PROXY_API_KEY=change-me \
  -v cartethyia-data:/app/data cartethyia
```

## Railway

Use the platform-provided `PORT`, persist `DATA_DIR` when possible, inject secrets through Railway variables, and configure the health path as `GET /health`. Railway only needs a successful HTTP status; the body is informational. Ensure proxy timeouts allow long-running streams.

## First-run checklist

1. Persist `DATA_DIR`.
2. Configure console and proxy secrets.
3. Add a provider account.
4. Confirm `GET /health` returns HTTP 200.
5. Send an authenticated request.
6. Inspect account health and quota in the console.
