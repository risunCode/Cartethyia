# HANDOFF: compiled binary crashes on POST routes with body schemas

## Status

The Docker **build** now succeeds (fixed and committed in `079aef5`). The Docker
**runtime crashes** the moment a route with a body schema is hit. The container
never starts serving: the first POST to `/console/api/auth/login` throws and
`listen()` fails.

```
error: [Elysia] Failed to compile route POST /console/api/auth/login:
  undefined is not an object (evaluating 'this.tb.buildResult.external')
TypeError: undefined is not an object (evaluating 'this.tb.buildResult.external')
```

This is NOT a Docker problem. It reproduces with a locally built binary.

## Reproduce locally (reliable)

```bash
# A local Redis must be running, and this must be REDIS_MODE=normal.
# With REDIS_MODE=single_instance_local the console routes are NOT mounted,
# so the crash does not appear — that is why it was missed earlier.
bun run mkdb.ts cartethyia_x            # create empty db (script was deleted; any fresh db works)
bun run build                            # dashboard:build -> build:aot -> build:binary
mkdir -p tmp/app/dist && cp -r drizzle/migrations tmp/app/migrations
cp -r dist/dashboard tmp/app/dist/dashboard && cp dist/cartethyia.exe tmp/app/
cd tmp/app
DATABASE_URL="postgres://postgres@localhost:5432/cartethyia_x" \
CARTETHYIA_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000" \
CARTETHYIA_API_KEY="rk_x" REDIS_MODE=normal REDIS_URL="redis://localhost:6379" \
NODE_ENV=production PORT=12880 DASHBOARD_DIST=./dist/dashboard ./cartethyia.exe

curl -X POST -H 'content-type: application/json' \
  -d '{"username":"x","password":"y"}' http://localhost:12880/console/api/auth/login
# -> the TypeError above
```

`bun run src/main.ts` (source, not compiled) works fine — 401, no crash.
Only the compiled binary fails.

## What was established (all verified by running, not reading)

1. **`typebox/schema.Compile()` has no `buildResult` property.** Verified across
   typebox 1.3.27 / 1.3.30 / 1.3.34:
   - `require("typebox/schema").Compile(schema).buildResult` → **undefined**
   - `require("typebox/compile").Compile(ctx, schema).buildResult` → **present**

2. **Elysia beta.16 reads `this.tb.buildResult.external` on the runtime path.**
   `node_modules/elysia/dist/type/validator/index.js:283-284`:
   ```js
   this.tb = capturing && captureImpl
     ? captureImpl.sourceOnlyValidator(this.schema)
     : SchemaCompile(this.schema);          // <- typebox/schema, no buildResult
   this.isAsync = this.tb.buildResult.external.variables.some(...)  // <- throws
   ```
   `SchemaCompile` is bound to `typebox.schema.Compile` in
   `dist/type/typebox-value.js:57`.

3. **The AOT plugin only captures the route-only shell.** Its capture run
   executes `src/main.ts` with `Manifest.isCapturing()` true, where `main.ts`
   builds `createGatewayShell()` (dashboard + `/health` + `/metrics` only) and
   skips `bootstrap()`. So `/v1/*` and `/console/*` are **absent from the frozen
   manifest** and their validators are compiled at runtime — which is the broken
   path. This is the root reason the two `strip` modes are both unusable:
   - `strip: 'auto'`/`true` → TypeBox gets wired statically (no missing-module
     error) but the handler JIT is stubbed, so the un-manifested routes throw
     `handler compiler JIT was stripped (strip mode) but a route needed runtime
     compilation`.
   - `strip: false` → JIT is present, but bridge mode becomes `'off'`, TypeBox
     is NOT wired statically, and the binary dies with
     `Cannot find module 'typebox/type'`.

4. **Elysia ships a CJS and an ESM build, and Bun picks the CJS one.**
   `package.json` has `"main": "./dist/index.js"` (CJS) and
   `"exports": { ".": { "import": "./dist/index.mjs", "require": "./dist/index.js" } }`.
   `require.resolve("elysia")` → `dist/index.js`. The CJS `dist/type/bridge-live.js`
   has top-level `require("typebox/type")`, which a bundler cannot follow; the
   ESM `dist/type/bridge-live.mjs` uses static `import { Ref } from "typebox/type"`,
   which it can.

5. **`setupTypebox({ typebox: {...} })` does not help under AOT.** Per the plugin's
   own docs, in the `wired`/`sealed` bridge modes `setupTypebox` is stubbed and
   the bridge is re-routed, so a manual registration is overridden.

6. **`--conditions=import` fixes Elysia but BREAKS `pg`.** With that flag,
   `pg` resolves to `pg/esm/index.mjs`, and a compiled binary then throws
   `TypeError: The superclass is not a constructor` inside `pg`'s `poolFactory`.
   Verified in isolation: a minimal `new Pool(...)` program works compiled with
   the default condition and fails with `--conditions=import`. `pg`'s `exports`
   map has `"import": "./esm/index.mjs"`, `"require": "./lib/index.js"`.

## Approaches already tried and their result

| Attempt | Result |
|---|---|
| `strip: false` only | `Cannot find module 'typebox/type'` at boot |
| default `strip` only | `handler compiler JIT was stripped` on POST |
| `strip:false` + `setupTypebox` | still `this.tb.buildResult.external` |
| `setupTypebox` + `schema.Compile = typebox/compile.Compile` | still same |
| no AOT plugin + `setupTypebox` | `Cannot find module 'typebox/type'` |
| `--conditions=import` (+ AOT `strip:false`) | `pg`: `superclass is not a constructor` |
| `--bytecode` | build fails outright (already removed) |

## Hypotheses for whoever picks this up

- **Upgrade `elysia`.** beta.16 is a beta; the `typebox/schema` vs
  `typebox/compile` mismatch is likely fixed in a later beta/exp. The project
  pins `elysia@2.0.0-beta.16`; check newer `2.0.0-beta.*` / `2.0.0-exp.*` for
  whether `SchemaCompile` was pointed at `typebox/compile`'s `Compile`.
- **Or pin `typebox` to a version where `schema.Compile` carries `buildResult`.**
  None of 1.3.27/1.3.30/1.3.34 do, so this may not exist — verify against the
  Elysia release notes for the version it expects.
- **Or make Elysia resolve to its ESM build without affecting `pg`**, e.g. a
  Bun plugin / `bunfig.toml` alias that maps only `elysia` to
  `elysia/dist/index.mjs`, leaving `pg` on CJS.
- **Or make the AOT capture see the full app.** If the capture run built the
  real `createGatewayApp` (not the shell), all routes would be in the frozen
  manifest and the runtime-compile path would never be taken — `strip:'auto'`
  would then be safe and TypeBox would stay wired.

## Also fixed in this session (committed)

- `079aef5` — Docker build (bytecode flag, AOT output as compile entry, NODE_ENV
  baked at build time, `scripts/` copied), fresh-database self-sufficiency
  (baseline missing `network_pools.kind` + `telemetry_events.error_origin`;
  `test/helpers/db-gate.ts` now migrates + seeds).
- `fe3ea09` — Antigravity OAuth client secret base64-encoded.

## Note for the next agent

The user's deployment target is Railway, which **injects its own `PORT`**. The
binary must therefore not hardcode the port. Also: the user asked about a volume
mount path and the correct answer is `/app/data` (the telemetry payload store
default is `./data/telemetry-payloads` relative to `WORKDIR /app`), NOT `/data`.
That mount is currently not usable anyway because `/app` is root-owned while the
process runs as `cartethyia`.
