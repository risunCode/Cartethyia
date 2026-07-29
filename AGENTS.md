# Cartethyia Engineering Conventions

## Release status

- Current release line: `1.0.0-alpha`.
- Keep the root and dashboard package versions aligned with the current release line.
- Record user-visible changes in `CHANGELOG.md` under the matching version before a release is declared.
- Alpha status means local/self-hosted testing is supported; avoid presenting the release as production-stable until the alpha caveats are cleared.

## Start here

- Read the requested feature area before editing. Reuse existing patterns; do not introduce a second implementation for the same concern.
- When `.codegraph/` is available, call CodeGraph before broad source searches. If its index is stale or disabled, read only the named files needed for the task.
- Use LSP for definitions, references, rename operations, and type-aware refactors. Use text search only for string literals, configuration, and static assets.
- External provider behavior, Railway configuration, package versions, and security guidance change frequently. Verify them from official documentation with web search before changing integration behavior or deployment documentation.

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
- Runtime request/error logs are JSONL under `DATA_DIR/logs`; do not persist runtime logs in SQLite.
- SQLite is configuration state only. Preserve encrypted credential behavior and avoid schema migrations unless explicitly required.
- Never commit `data/`, `.env`, credentials, API keys, tokens, generated runtime payloads, or database files.

## Testing and delivery

- For backend changes run `bunx tsc --noEmit -p .` and the narrowest relevant `bun test` target; run the full suite for cross-cutting changes.
- For dashboard changes run `cd dashboard && bun run build`; use the browser for visible interaction changes when console authentication is available.
- For Docker changes build the image and exercise `/health` before reporting completion.
- For Railway changes keep `railway.toml`, `Dockerfile`, `.dockerignore`, and README deployment steps aligned. Do not place secrets in image layers or repository files.
