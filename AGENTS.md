# Cartethyia Engineering Conventions

## Release status

- `package.json`'s `version` is the single source of truth for the release line; README surfaces it, nothing else restates it. Keep `dashboard/package.json` aligned with the root version.
- Record user-visible changes in `CHANGELOG.md` under the matching version before a release is declared.
- Alpha status means local/self-hosted testing is supported; avoid presenting the release as production-stable until the alpha caveats are cleared.

## Start here

- Read the requested feature area before editing. Reuse existing patterns; do not introduce a second implementation for the same concern.
- When `.codegraph/` is available, call CodeGraph before broad source searches. If its index is stale or disabled, read only the named files needed for the task.
- Use LSP for definitions, references, rename operations, and type-aware refactors. Use text search only for string literals, configuration, and static assets.
- External provider behavior, Railway configuration, package versions, and security guidance change frequently. Verify them from official documentation with web search before changing integration behavior or deployment documentation.

## Commit messages

- Use Conventional Commit subjects with a concise, specific summary, for example `fix: ...`, `feat: ...`, `perf: ...`, or `release: <version> — <summary>`.
- For multi-area changes, write the body like the established repository style: a short context paragraph, descriptive numbered sections, nested bullets for concrete changes, and a `Verified:` section listing checks that actually ran.
- Keep each section meaningful and specific; avoid generic one-word summaries that hide the affected behavior.
- Use real line breaks in the commit body; never encode newlines as escape sequences or escaped text.
- Do not claim tests, benchmarks, smoke tests, or user confirmation unless they were actually performed.

## TypeScript and React

- Keep TypeScript strict. Use `unknown` at external boundaries and narrow it; do not add `any`, `@ts-ignore`, or unchecked assertions.
- Use named ESM exports, `import type` for type-only imports, explicit types on exported APIs, and narrow discriminated unions for protocol variants.
- Use `const` unless reassignment is necessary. Prefer early returns and small focused functions.
- React components follow existing dashboard primitives (`Card`, `Button`, `Dialog`, `Badge`). Preserve responsive Tailwind layouts and accessible labels for controls.
- Do not render untrusted Markdown with `dangerouslySetInnerHTML`. Keep any lightweight renderer structural and escaped.

## Provider and routing changes

- A built-in provider change is cross-cutting: update its registry, route prefix/types, provider metadata, model catalog, UI icon, and all resolver callsites.
- Provider errors must be typed `ProviderCallError` with a useful status/kind. Never turn an upstream failure into a successful empty completion.
- Keep provider reasoning separate from visible output: emit `thinking_delta` for reasoning and `text_delta` only for final text.
- Test provider changes using the actual request path when credentials are available; otherwise add a deterministic protocol/unit test.

## Persistence and logs

- `DATA_DIR` is the deployment persistence boundary. Production mounts it at `/app/data`.
- Config state (`DATA_DIR/cartethyia.sqlite`, `src/console/db/schema.ts`) and runtime telemetry (`DATA_DIR/runtime.sqlite`, `src/console/db/runtime-schema.ts`) are two separate SQLite databases/connections — never merge them. Config holds API keys, providers, and settings; runtime holds `request_history`, `request_details`, `request_assets`, `request_tool_calls`, and `console_logs`, all with date-cutoff retention (`LOG_RETENTION_DAYS`/`ASSET_RETENTION_DAYS`) run every 6h by `src/console/tracking/rotate.ts`. Both run WAL mode; the runtime db additionally uses `synchronous=NORMAL` since traffic telemetry can tolerate the narrow crash-window tradeoff for write throughput that config state should not.  There is no in-memory cache, JSONL log file, or per-request payload file for any of this — every read is a direct SQL query, and redacted request/response bodies (`TRACK_PAYLOADS=store`) live inline in `request_details`, not a companion file under `DATA_DIR/payloads`.
- SQLite is configuration state only. Provider credentials and proxy API keys are stored as plaintext; only the console login password is hashed. Avoid schema migrations unless explicitly required (this applies to both databases).
- Proxy API key ACL lives in `api_keys` (`provider_allowlist`, `model_allowlist`, `model_denylist`, RPM, daily/monthly token limits, `max_concurrent_requests`). Shared enforcement is in `src/console/key-acl.ts` and `src/console/proxy-auth.ts`; `/v1/models` filters through the same helper when a key is presented.
- Console key management: `POST /console/api/keys` (create), `PATCH /console/api/keys/:id` (update limits/ACL), `POST /console/api/keys/:id/revoke`, `DELETE /console/api/keys/:id`, `GET /console/api/keys/:id/credential`.
- Never commit `data/`, `.env`, credentials, API keys, tokens, generated runtime payloads, or database files.

## Testing and delivery

- For backend changes run `bunx tsc --noEmit -p .` and the narrowest relevant `bun test` target; run the full suite for cross-cutting changes. Always scope backend runs to `bun test test/` (or a path under it) - a bare `bun test` at the repo root also walks `dashboard/src/**/*.test.tsx`, which use Vitest-only APIs (`vi.importActual`, etc.) that fail under Bun's test runner.
- For dashboard changes run `cd dashboard && bun run build && bun run test`; use the browser for visible interaction changes when console authentication is available. Dashboard tests run under Vitest (`dashboard/vite.config.ts`'s `test` block, jsdom environment) - add new component/unit tests under `dashboard/src/**/*.test.{ts,tsx}`.
- For Docker changes build the image and exercise `/health` before reporting completion.
- For Railway changes keep `railway.toml`, `Dockerfile`, `.dockerignore`, and README deployment steps aligned. Do not place secrets in image layers or repository files.
