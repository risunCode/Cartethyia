/**
 * Versioned, immutable routing configuration snapshot.
 *
 * The data plane resolves every request through a frozen snapshot of the
 * routing-relevant configuration (provider prefixes, aliases, combos, proxy
 * pool ids, account rows). The snapshot is rebuilt only when the revision
 * counter moves — i.e. when a console mutation touches one of the
 * routing-relevant repositories — never per request.
 *
 * This module owns the storage/provider-registry reading side of the snapshot
 * path at the application boundary; the domain keeps only the pure model
 * chain, routing, and health rules.
 *
 * Concurrency: JavaScript is single-threaded, and the cache only ever
 * publishes a snapshot whose `revision` equals the counter it was built
 * from. A rebuild that races a mutation may briefly displace a newer
 * snapshot, but the next lookup sees the counter mismatch and rebuilds, so
 * stale configuration is never served. Snapshots are immutable by
 * convention (arrays and the snapshot object are frozen); requests share
 * them without copying.
 */

import type { CredentialKind } from "./contracts";
import type { ComboDefinition } from "./routing";
import type { ConfigPersistence } from "../storage";
import type { ProviderRegistry } from "../providers/registry";

/** Minimal account row shape used for route candidate construction. */
export interface SnapshotAccountRow {
  readonly id: string;
  readonly providerId: string;
  readonly credentialKind: CredentialKind;
  readonly active: boolean;
}

export interface RoutingSnapshot {
  /** Monotonic revision this snapshot was built from. */
  readonly revision: number;
  /** Provider alias prefix → provider id (registry-backed). */
  readonly prefixes: ReadonlyMap<string, string>;
  /** Model name alias → target model name. */
  readonly aliases: ReadonlyMap<string, string>;
  /** Named combos (strategy + stickiness normalized). */
  readonly combos: ReadonlyMap<string, ComboDefinition>;
  /** Account rows grouped by provider, in repository order. */
  readonly accountsByProvider: ReadonlyMap<string, readonly SnapshotAccountRow[]>;
  /** DB-stored model IDs per provider (fetched/custom) — supplements the adapter catalog for routing gates. */
  readonly knownModelIds: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface RouteSnapshotSources {
  readonly config: ConfigPersistence;
  readonly registry: ProviderRegistry;
  /** Monotonic revision bumped by every routing-relevant config mutation. */
  readonly readRevision: () => number;
}

export interface RouteSnapshotCache {
  /** Current snapshot; rebuilt lazily when the revision advanced. */
  get(): Promise<RoutingSnapshot>;
}

export function createRouteSnapshotCache(sources: RouteSnapshotSources): RouteSnapshotCache {
  let cached: RoutingSnapshot | null = null;
  let rebuildPromise: Promise<RoutingSnapshot> | null = null;

  const rebuild = async (): Promise<RoutingSnapshot> => {
    while (true) {
      const revision = sources.readRevision();
      const snapshot = await buildSnapshot(sources, revision);
      if (sources.readRevision() === revision) {
        cached = snapshot;
        return snapshot;
      }
    }
  };

  return {
    async get(): Promise<RoutingSnapshot> {
      const revision = sources.readRevision();
      const current = cached;
      if (current !== null && current.revision === revision) return current;
      if (rebuildPromise !== null) return rebuildPromise;
      const promise = rebuild();
      rebuildPromise = promise;
      void promise.then(
        () => {
          if (rebuildPromise === promise) rebuildPromise = null;
        },
        () => {
          if (rebuildPromise === promise) rebuildPromise = null;
        },
      );
      return promise;
    },
  };
}

async function buildSnapshot(sources: RouteSnapshotSources, revision: number): Promise<RoutingSnapshot> {
  const { config, registry } = sources;

  const prefixes = new Map<string, string>();
  for (const adapter of registry.list()) {
    prefixes.set(adapter.metadata.id, adapter.metadata.id);
    if (adapter.metadata.id === "opencodeft") prefixes.set("opencode", adapter.metadata.id);
    // Register the first segment of each builtin catalog model ID as a prefix
    // so unqualified model names like "blackboxai/openai/gpt-5.3-codex"
    // resolve to the correct provider even though the prefix ("blackboxai")
    // matches the provider ID directly.
    for (const model of adapter.models.list) {
      const sep = model.id.indexOf("/");
      if (sep > 0) {
        const modelPrefix = model.id.slice(0, sep);
        if (!prefixes.has(modelPrefix)) prefixes.set(modelPrefix, adapter.metadata.id);
      }
    }
  }
  // Also register DB-stored custom models as prefixes so fetched/added
  // models are routable without restarting the server.
  const providerModels = config.providerModels;
  const knownModelIds = new Map<string, Set<string>>();
  if (providerModels !== undefined) {
    for (const adapter of registry.list()) {
      const ids = new Set<string>();
      for (const model of providerModels.list(adapter.metadata.id)) {
        ids.add(model.modelId);
        const sep = model.modelId.indexOf("/");
        if (sep > 0) {
          const modelPrefix = model.modelId.slice(0, sep);
          if (!prefixes.has(modelPrefix)) prefixes.set(modelPrefix, adapter.metadata.id);
        }
      }
      if (ids.size > 0) knownModelIds.set(adapter.metadata.id, ids);
    }
  }

  const aliases = new Map(config.aliases.list().map((row) => [row.alias, row.model]));

  const combos = new Map<string, ComboDefinition>(
    config.combos.list().map((row) => [
      row.name,
      {
        id: row.id,
        models: row.models,
        strategy: row.strategy === "round-robin" ? "round-robin" : "fallback",
        stickyLimit: row.stickyLimit,
      },
    ]),
  );

  const accountsByProvider = new Map<string, SnapshotAccountRow[]>();
  for (const row of config.accounts.list()) {
    let rows = accountsByProvider.get(row.provider);
    if (rows === undefined) {
      rows = [];
      accountsByProvider.set(row.provider, rows);
    }
    rows.push({ id: row.id, providerId: row.provider, credentialKind: row.credentialKind, active: row.active });
  }

  const frozenAccounts = new Map<string, readonly SnapshotAccountRow[]>();
  for (const [providerId, rows] of accountsByProvider) frozenAccounts.set(providerId, Object.freeze(rows));

  const frozenModelIds = new Map<string, ReadonlySet<string>>();
  for (const [providerId, ids] of knownModelIds) frozenModelIds.set(providerId, ids);

  return Object.freeze({
    revision,
    prefixes,
    aliases,
    combos,
    accountsByProvider: frozenAccounts,
    knownModelIds: frozenModelIds,
  });
}