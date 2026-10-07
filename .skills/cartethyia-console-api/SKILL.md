---
name: cartethyia-console-api
description: "Add or change a console API domain: src/console/** contracts, routes, stores, guards, error envelope, route-snapshot invalidation, and the dashboard contract mirror. Use for any /console/api endpoint."
---

# Console API

Use for `src/console/**`: adding or changing an endpoint, a domain, an access
check, or the error envelope. For the browser side of the same change use
`cartethyia-dashboard`; for provider/catalog semantics use
`cartethyia-provider-catalog`.

Read `documentation/console-api.md` for orientation first.

## When not to touch a route

A route is the narrowest layer. If the bug is in a store query, a validator, or a
projection, fix it there and leave `routes.ts` alone. 95 route handlers used to
each carry their own `try/catch`; that was collapsed into one `error()` hook, so
adding a try/catch back is going backwards.

## Procedure

1. **Find the owner.** `codegraph_explore` with the endpoint path or the symbol.
   One behaviour, one canonical owner.
2. **Read the domain end to end** — `contracts.ts`, then `routes.ts`, then
   `store.ts` or `service.ts`. Do not skip `contracts.ts`: the operations factory
   and the validation live there in most domains.
3. **Contract first.** Add the request/response types, the store method, and the
   validation to `contracts.ts`. Declare member lists as `as const` tuples and
   project the Elysia schema from them with `literalUnion()`
   (`src/console/shared/elysia-schema.ts:17`). Keep `contracts.ts` free of Elysia
   and Node builtins when the dashboard will import the types — see
   `src/console/routing/pools/contracts.ts:3`. `api-keys/contracts.ts:7` and
   `routing/pools/contracts.ts:8` do import `node:crypto`/`node:net`; the
   dashboard re-exports only their pure neighbours
   (`src/console/api-keys/share-popup-image.ts:1-7`), so check before adding one.
4. **Operations second.** Authorise, validate, mutate, audit, invalidate. The
   factory takes `access` as its first argument and narrows it before touching the
   store — `requireTenantScope(access, "dashboard:write")` is the normal shape.
5. **Route third.** `routes.ts` binds the path, the schema, and `set.status`, and
   does nothing else. Register `.error(consoleErrorHandler("<area> operation failed"))`
   once per route group rather than wrapping handlers.
6. **Wire it.** No new domain mounts itself. Add one
   `console.use(createXRoutes({ ...ctx fields ... }))` in
   `src/console/domain-registration.ts`. Only the auth routes are mounted by
   `console-router.ts`.
7. **Mirror the contract.** Add or update the type in
   `dashboard/src/data/contracts.ts`, which re-exports the backend module rather
   than restating it. If the payload changed, the hook and the page change with it.

## Contract → store → dashboard mirror

One source of truth for each payload shape. The dashboard imports the backend
contract as types; it does not keep a second, drifted copy
(`dashboard/src/data/contracts.ts:1-8`). Value re-exports are allowed only from
pure modules, because a value import drags whatever it reaches into the browser
bundle — `observability/contracts` imports Elysia and reaches `node:crypto`, which
is why `USAGE_DIMENSIONS` is re-exported from the pure `usage-dimensions.ts`
(`dashboard/src/data/contracts.ts:9-15`).

## Errors and status codes

`ConsoleDomainError` (`src/console/shared/errors.ts:14`) carries `code`, `status`,
and optional `details`. Every domain throws it; `errorResponse()`
(`shared/errors.ts:42`) shapes it into `{ error, code, details? }` and sets
`set.status`. A throw that is not shaped becomes 500 `internal_error` with the
group's fallback message.

`consoleErrorHandler(fallbackMessage)` (`shared/errors.ts:160`) is the group-level
hook. It maps an Elysia `ValidationError` to 422 `invalid_request` — a schema
failure is the caller's fault, not a 500 — and lets Elysia's own control-flow
throws keep their numeric status.

Codes in use: `unauthorized` 401, `insufficient_scope` 403, `tenant_required` 403,
`invalid_request` 400, `not_found`/`<thing>_not_found` 404, `quota_exceeded` 429,
`ssrf_rejected` 400. Reuse these before inventing one.

`detailsPolicy` controls whether `details` reaches the client. `settings` passes
`"omit"` (`settings/contracts.ts:137`) because a preferences patch echoes the whole
bag; do not widen it without a reason.

## Guards you must not remove

- The CSRF middleware and the mutation limiter (`src/console/console-router-guards.ts:21`,
  `:77`). Both are hard-coded against `/console/api/`. Adding a path to their
  `excluded` lists is a security change; the four entries exist because those
  endpoints run before a session exists.
- `requireTenantScope` / `requireTenantAnyScope`. A `null` tenant id is a
  platform-admin session; narrowing on the tenant is what keeps it from writing
  as a tenant.
- The password re-authentication on backup export, import, and delete-all
  (`src/console/backup/routes.ts:1-13`). An export is every credential in the clear.
- The per-request `BackupService` factory. A long-lived instance would hold one
  request's operator identity into the next.
- `snapshotInvalidator?.invalidate()` after any write that changes routing:
  catalog models, aliases, combos, pools, CLI mappings, restore.

## Verify

```bash
bun run typecheck                # always
bun run dashboard:typecheck      # when the contract mirror changed
bun run test:backend             # test/console/** lives here
```

Typecheck is not behavioural proof. Console suites in `test/console/` mount the
real router through `createTestGateway` (`test/helpers/gateway.ts:331`, console
mounted unless `options.console === false`), so a test there exercises the guards
too — see `test/console/remote-debug-access.test.ts` for that shape. New pure
helpers get their own suite; `test/console/query-limit.test.ts` is the model.

Prove a new test locks the fix: revert the change, see it fail, restore it, see it
pass.

## Pitfalls

- **Path shadowing.** `/:providerId` swallows a later literal. `connection-test`
  is declared before it in `providers/catalog/routes.ts:147` for exactly this
  reason; the comment says so.
- **Optional `ctx` fields.** `modelStrikes` is optional, so the model-ban routes
  are not mounted at all when it is absent (`domain-registration.ts:231`). A route
  that silently disappears is worse than one that 500s; keep that explicit.
- **`as unknown as Elysia` on every route factory.** The beta's route-tree types
  do not line up. It is load-bearing, not sloppiness — do not "fix" it.
- **Do not import `transport/` into the console.** Declare the structural
  interface you need instead (`observability/live.ts:15`).
- **`t.UnionEnum` stamps a default of its first member**, so an absent body field
  validates as that member. Use `literalUnion()`.
- **Body-size checks must run before JSON parse** or the point of the limit is
  lost — `backup/routes.ts:137` measures the re-serialized body because a spoofed
  `content-length` would otherwise bypass the 413.
- **A console read of a shared row uses `globalOrOwnedBy`, not `eq(tenantId)`.**
  Replacing it hides shared catalog rows. Quota and OAuth owner checks use `eq` on
  purpose.
