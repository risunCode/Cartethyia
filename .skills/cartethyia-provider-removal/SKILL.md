---
name: cartethyia-provider-removal
description: "Remove a bundled Cartethyia provider, including its persisted global row, so it cannot linger as an undeletable custom card."
---

# Provider removal

Removing a bundled provider is a catalog cutover plus a persisted-row cleanup.
Deleting the metadata is not enough: the old global `providers` row stays
visible, and the tenant delete cannot reach it.

## Cutover

1. Remove the provider from `BUNDLED_PROVIDER_METADATA` and
   `BUNDLED_PROVIDER_MODULES`. `isBundledProviderId` is derived from that
   metadata, so a leftover id is no longer builtin the moment the metadata
   goes.
2. Remove its adapter, auth, discovery, quota, and request-shaping modules.
   Search registry, routes, dashboard mirrors, `base-models.json`, scripts,
   and docs. Migrate every caller in the same change.
3. Do not leave an alias, shim, or compatibility id. Do not delete telemetry
   history. Do not delete shared models by `model_id` alone.

## The stuck card

A retired bundled provider leaves `providers.id = <old-id>` with
`tenant_id IS NULL`.

- `list` uses `globalOrOwnedBy`, so every tenant sees that row.
- `mapProviderRow` sets `isBuiltIn` from `isBundledProviderId`. After removal
  that is false, so the dashboard draws it under Custom Providers.
- Tenant `DELETE /providers/:id` used to filter `ownedByOnly`. A global row
  matches nothing, the store returns false, and the operation throws
  `Provider <id> not found`.
- `deleteGlobal` can delete `tenant_id IS NULL`, but only after the id is no
  longer bundled. Current builtins still 403.

The owner is the catalog list and delete, not a dashboard special case. Do
not hardcode the retired id in React.

## Required cleanup

- Boot calls `retireUnbundledProviders` after `seedBundledProviders`. It
  deletes unowned rows whose id is absent from the bundle. Model, account,
  and routing rows cascade from `providers.id`. A tenant-owned BYOK row is
  out of scope.
- `DrizzleProviderCatalogStore.list` must not project an unowned row whose id
  is absent from the bundle. Otherwise the card survives until the next boot.
- Tenant delete must remove that orphan global row when the owned delete
  misses. `deleteGlobal` still refuses a current bundled id, so this must not
  make a live builtin deletable.

## Prove it

Insert a global provider row with an id absent from the bundle. Assert the
tenant list omits it, tenant delete removes it, and deleting a real bundled
id still returns `provider_is_builtin` / 403. A tenant-owned row with the
same shape must survive retirement.
