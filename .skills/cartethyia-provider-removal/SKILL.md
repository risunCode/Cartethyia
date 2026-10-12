---
name: cartethyia-provider-removal
description: "Remove a bundled Cartethyia provider, including its persisted global row, so it cannot linger as an undeletable custom card."
---

# Provider removal

Removing a bundled provider is a catalog cutover plus a persisted-row cleanup.
Deleting the metadata is not enough: an old global `providers` row may remain
until the boot retirement step runs.

## Cutover

1. Remove the provider's row from `RAW_BUNDLED_PROVIDER_METADATA` in
   `src/providers/metadata.ts` and its entry from `PROVIDER_CAPABILITIES` in
   `src/providers/default-registry.ts`. `BUNDLED_PROVIDER_MODULES` is derived
   from those declarations; its construction throws if metadata names a
   provider with no capability entry. `isBundledProviderId` derives from the
   exported metadata, so removing the metadata row is what makes the id no
   longer builtin.
2. Remove its adapter, auth, discovery, quota, and request-shaping modules.
   Search registry, routes, dashboard mirrors, `base-models.json`, scripts,
   and docs. Migrate every caller in the same change.
3. Do not leave an alias, shim, or compatibility id. Do not delete telemetry
   history. Do not delete shared models by `model_id` alone.

## Why a stale global row used to stick

Before retirement cleanup, removing a bundled provider could leave
`providers.id = <old-id>` with `tenant_id IS NULL`, which used to cause a
stuck custom-provider card:

- The old list projection exposed every global row, while `mapProviderRow`
  derived `isBuiltIn` from `isBundledProviderId`. After removal, that predicate
  returned false and the dashboard displayed the row under Custom Providers.
- Tenant delete first scopes to tenant-owned rows. Without the current
  fallback to `deleteGlobal`, that missed a global row and returned
  `provider_not_found` (404).

The owner is the catalog list and delete, not a dashboard special case. Do not
hardcode the retired id in React.

## Current safeguards

- Boot calls `retireUnbundledProviders` after `seedBundledProviders`; it deletes
  unowned rows absent from the bundle. Provider-owned model and account rows
  cascade through the provider foreign key. Tenant-owned BYOK rows are out of
  scope.
- `DrizzleProviderCatalogStore.list` includes global rows only when their ids
  are still bundled, so an orphan is hidden immediately, before the next boot.
- Tenant delete tries the tenant-owned delete, then `deleteGlobal` for a
  remaining global orphan. `deleteGlobal` rejects a currently bundled id, so a
  live builtin remains undeletable.
- `test/providers/catalog-seeder-reconciliation.test.ts` covers retirement,
  tenant-list hiding, orphan deletion, builtin protection, and preservation of
  tenant-owned rows.

## Prove it

When changing this behavior, insert a global provider row with an id absent
from the bundle. Assert the tenant list omits it, tenant delete removes it, and
deleting a real bundled id still returns `provider_is_builtin` / 403. A
tenant-owned row with the same shape must survive retirement.
