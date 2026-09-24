/**
 * Public model catalog: the read-only `/v1/models` surface an API key sees.
 *
 * Answers "which models may this key use, and what are they?" by intersecting
 * the enabled catalog with the key's provider/model allow- and denylists, then
 * applying the key's `model_prefix`. Kept separate from the operator-facing
 * `DrizzleProviderCatalogStore` because the two have different trust levels:
 * this one is driven entirely by untrusted caller input plus one frozen
 * authorization snapshot.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { modelAliases, modelCombos, models, providerAccounts, providers } from "../../../persistence/schema";
import { isModelAllowed, isProviderAllowed, listIncludes, type ApiKeyAuthorizationSnapshot } from "../../../security/api-key-auth";

export interface AllowedModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: unknown;
}

function matchesModelPrefix(
  modelPrefix: string | undefined,
  bareModelId: string,
  qualifiedModelId?: string,
): boolean {
  const prefix = modelPrefix?.trim();
  if (!prefix) return true;
  return bareModelId.startsWith(prefix) || qualifiedModelId?.startsWith(prefix) === true;
}

/** Catalog metadata mirrored onto an alias or combo entry. */
interface ModelMetadata {
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities: unknown;
}

/** Defaults advertised when a target has no catalog row to describe it. */
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_OUTPUT_LIMIT = 64_192;

/** Bound on the alias/combo walk; matches the engine's `resolveAlias` depth. */
const MAX_TARGET_DEPTH = 16;

/**
 * Resolves a routing name to the catalog ids it can actually reach.
 *
 * An alias may target a combo rather than a model (`muse-spark-1.3` →
 * `muse-pool`), and a combo member may itself be an alias or combo, exactly as
 * dispatch resolves them. Reading only the immediate target would miss the
 * catalog rows that describe the route and fall back to invented limits. A
 * name that resolves to nothing concrete is returned as-is so the lookup can
 * still match a bare catalog id.
 */
function resolveTargetIds(
  name: string,
  aliasTargets: ReadonlyMap<string, string>,
  comboMembers: ReadonlyMap<string, readonly string[]>,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  if (seen.has(name) || seen.size >= MAX_TARGET_DEPTH) return [];
  const next = new Set(seen).add(name);
  const members = comboMembers.get(name);
  if (members) return members.flatMap((m) => resolveTargetIds(m, aliasTargets, comboMembers, next));
  const target = aliasTargets.get(name);
  if (target !== undefined) return resolveTargetIds(target, aliasTargets, comboMembers, next);
  return [name];
}

/**
 * The metadata a routing name advertises, given the ids it can reach.
 *
 * A pool may route to any member, so the conservative claim is the minimum
 * across them and only the modalities every member shares. `null` limits mean
 * "no catalog row described this id"; the caller substitutes the defaults.
 */
function advertisedMetadata(
  ids: readonly string[],
  meta: ReadonlyMap<string, ModelMetadata>,
): ModelMetadata {
  const found = ids
    .map((id) => meta.get(id))
    .filter((entry): entry is ModelMetadata => entry !== undefined);
  if (found.length === 0) return { contextLimit: null, outputLimit: null, modalities: undefined };
  return {
    contextLimit: Math.min(...found.map((m) => m.contextLimit ?? DEFAULT_CONTEXT_LIMIT)),
    outputLimit: Math.min(...found.map((m) => m.outputLimit ?? DEFAULT_OUTPUT_LIMIT)),
    modalities: intersectModalities(found.map((m) => m.modalities).filter((m) => m != null)),
  };
}

/** Input/output modalities every member shares; `undefined` when none do. */
function intersectModalities(entries: readonly unknown[]): unknown {
  if (entries.length === 0) return undefined;
  const normalize = (entry: unknown): { input?: readonly string[]; output?: readonly string[] } =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { input?: readonly string[]; output?: readonly string[] })
      : {};
  const first = normalize(entries[0]);
  const input = new Set(first.input ?? []);
  const output = new Set(first.output ?? []);
  for (const entry of entries.slice(1)) {
    const next = normalize(entry);
    for (const value of [...input]) {
      if (!(next.input ?? []).includes(value)) input.delete(value);
    }
    for (const value of [...output]) {
      if (!(next.output ?? []).includes(value)) output.delete(value);
    }
  }
  if (input.size === 0 && output.size === 0) return undefined;
  return {
    ...(input.size > 0 ? { input: [...input] } : {}),
    ...(output.size > 0 ? { output: [...output] } : {}),
  };
}

/** Last `/`-separated segment of a model id: the bare name a client types. */
function lastSegment(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

/**
 * True when a catalog row should stay hidden because its visibility comes only
 * from a bare allowlist entry that is really an alias or combo name.
 *
 * `isModelAllowed` deliberately matches a bare entry against every qualified
 * form, so `glm-5.3-flash` in the allowlist also clears
 * `cline/z-ai/glm-5.3-flash` and `workbuddy/glm-5.3-flash`. That is correct
 * for dispatch (the operator's intent is "this model, any provider") but wrong
 * for discovery: the operator published *one* name — the alias — and every
 * qualified form of it is the same route wearing a different label. So when an
 * alias is allowlisted, its bare name is the single public entry and every
 * qualified form is hidden. An explicitly qualified allowlist entry
 * (`workbuddy/glm-5.3-flash`) is an unambiguous grant of that exact row and is
 * never shadowed. The alias carries the target's real capabilities, so nothing
 * is lost.
 *
 * Both the row and the alias target are judged by their bare name as well as
 * their full id. A catalog row may nest its own path (`cline-free/gpt-5`), so
 * comparing only `row.modelId` let `cline-free/deepseek-v4.1-flash` survive
 * beside the allowlisted `deepseek-v4.1-flash` alias and reappear on whichever
 * provider happened to nest it — the exact leak this filter exists to stop.
 */
export function shadowsAliasOrCombo(
  row: { readonly providerId: string; readonly modelId: string },
  aliasTargets: ReadonlyMap<string, string>,
  comboNames: ReadonlySet<string>,
  snapshot: ApiKeyAuthorizationSnapshot,
): boolean {
  const qualified = `${row.providerId}/${row.modelId}`;
  // An explicit qualified entry is an unambiguous grant — never shadow it.
  if (listIncludes(snapshot.model_allowlist, qualified)) return false;
  const bare = lastSegment(row.modelId);
  for (const [alias, target] of aliasTargets) {
    if (!listIncludes(snapshot.model_allowlist, alias)) continue;
    // Hide every qualified form the alias covers: the alias itself already
    // represents the route, with the target's real limits and capabilities.
    if (target === qualified || target === row.modelId) return true;
    const bareTarget = lastSegment(target);
    if (row.modelId === alias || row.modelId === bareTarget) return true;
    if (bare === alias || bare === bareTarget) return true;
  }
  for (const name of comboNames) {
    if (!listIncludes(snapshot.model_allowlist, name)) continue;
    if (row.modelId === name || bare === name) return true;
  }
  return false;
}

export class PublicModelCatalogStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async listPublicModels(
    tenantId: string | null,
    snapshot: ApiKeyAuthorizationSnapshot,
    modelPrefix?: string,
  ): Promise<AllowedModelEntry[]> {
    const providerScope =
      tenantId === null
        ? isNull(providers.tenantId)
        : or(isNull(providers.tenantId), eq(providers.tenantId, tenantId));
    const rows = await this.db
      .select({
        providerId: models.providerId,
        contextLimit: models.contextLimit,
        modelId: models.modelId,
        outputLimit: models.outputLimit,
        modalities: models.modalities,
        providerRequiresAccount: providers.requiresAccount,
      })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(and(eq(models.enabled, true), eq(providers.enabled, true), providerScope));

    // Only expose models whose provider is either No-auth (requiresAccount=false,
    // e.g. opencodefree) or has at least one active account for this tenant.
    // This mirrors 21 beta's "No auth dan yang disetel apikey/oauth aja".
    const activeProviderIds = new Set<string>();
    if (tenantId !== null) {
      const activeAccounts = await this.db
        .select({ providerId: providerAccounts.providerId })
        .from(providerAccounts)
        .where(and(eq(providerAccounts.tenantId, tenantId), eq(providerAccounts.status, "active")));
      for (const row of activeAccounts) activeProviderIds.add(row.providerId);
    }

    // Alias and combo rows are loaded up front because they change what a bare
    // allowlist entry is allowed to expose (see the shadow filter below).
    const aliasRows = tenantId === null
      ? []
      : await this.db.select().from(modelAliases).where(eq(modelAliases.tenantId, tenantId));
    const comboRows = tenantId === null
      ? []
      : await this.db.select().from(modelCombos).where(eq(modelCombos.tenantId, tenantId));

    /**
     * Alias name -> the qualified id it resolves to.
     *
     * A bare allowlist entry matches *every* provider whose model id shares
     * that bare name, which would silently expose siblings the operator never
     * named: allowing the alias `glm-5.3-flash` would also surface
     * `workbuddy/glm-5.3-flash` and `cbcn/glm-5.3-flash` alongside the alias's
     * real target. When the allowlisted name is an alias, only its own target
     * stays visible; a sibling needs an explicit qualified entry.
     */
    const aliasTargets = new Map<string, string>();
    for (const alias of aliasRows) {
      if (typeof alias.alias === "string" && typeof alias.targetModel === "string") {
        aliasTargets.set(alias.alias, alias.targetModel);
      }
    }
    const comboNames = new Set<string>();
    for (const combo of comboRows) {
      if (typeof combo.name === "string") comboNames.add(combo.name);
    }

    const modelEntries: AllowedModelEntry[] = rows
      .filter((row) => {
        if (row.providerRequiresAccount === false) return true;
        if (tenantId === null) return false;
        return activeProviderIds.has(row.providerId);
      })
      .filter((row) => isProviderAllowed(snapshot, row.providerId))
      .filter((row) =>
        matchesModelPrefix(modelPrefix, row.modelId, `${row.providerId}/${row.modelId}`) ||
        isModelAllowed(snapshot, row.modelId) ||
        isModelAllowed(snapshot, `${row.providerId}/${row.modelId}`),
      )
      .filter(
        (m) =>
          isModelAllowed(snapshot, m.modelId) ||
          isModelAllowed(snapshot, `${m.providerId}/${m.modelId}`),
      )
      .filter((m) => !shadowsAliasOrCombo(m, aliasTargets, comboNames, snapshot))
      .map((m) => ({
        id: `${m.providerId}/${m.modelId}`,
        object: "model" as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: m.providerId,
        ...(m.contextLimit != null ? { context_length: m.contextLimit } : {}),
        ...(m.outputLimit != null ? { max_completion_tokens: m.outputLimit } : {}),
        ...(m.modalities ? { capabilities: m.modalities } : {}),
      }));

    // Expose tenant model aliases and combos as first-class public models.
    // `aliasRows`/`comboRows` were loaded above for the shadow filter.
    if (tenantId !== null) {

      // Capability mirroring reads the *catalog*, not the key-filtered list
      // above: an alias/combo should describe what its target can do even
      // when the key's allowlist names only the alias. Authorization is still
      // enforced per-request by admission, never widened here.
      const comboMembers = new Map<string, readonly string[]>();
      for (const combo of comboRows) {
        if (typeof combo.name === "string" && Array.isArray(combo.members)) {
          comboMembers.set(combo.name, combo.members.filter((m): m is string => typeof m === "string"));
        }
      }
      // Walk alias → combo → member so a target that is a pool name resolves
      // to the catalog rows that describe it; otherwise its limits would be
      // invented defaults rather than what the route can actually serve.
      const targetIds = [
        ...aliasRows.map((a) => resolveTargetIds(a.targetModel, aliasTargets, comboMembers)),
        ...comboRows.flatMap((c) => resolveTargetIds(c.name, aliasTargets, comboMembers)),
      ].flat();
      const targetMeta = await this.modelMetadataById(tenantId, targetIds);

      const now = Math.floor(Date.now() / 1000);
      for (const a of aliasRows) {
        if (!matchesModelPrefix(modelPrefix, a.alias) && !isModelAllowed(snapshot, a.alias)) continue;
        if (!isModelAllowed(snapshot, a.alias)) continue;
        const target = advertisedMetadata(resolveTargetIds(a.targetModel, aliasTargets, comboMembers), targetMeta);
        modelEntries.push({
          id: a.alias,
          object: "model" as const,
          created: now,
          owned_by: "cartethyia",
          context_length: target.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
          max_completion_tokens: target.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
          ...(target.modalities ? { capabilities: target.modalities } : {}),
        });
      }

      for (const c of comboRows) {
        if (!matchesModelPrefix(modelPrefix, c.name) && !isModelAllowed(snapshot, c.name)) continue;
        if (!isModelAllowed(snapshot, c.name)) continue;
        const target = advertisedMetadata(resolveTargetIds(c.name, aliasTargets, comboMembers), targetMeta);
        modelEntries.push({
          id: c.name,
          object: "model" as const,
          created: now,
          owned_by: "cartethyia",
          context_length: target.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
          max_completion_tokens: target.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
          ...(target.modalities ? { capabilities: target.modalities } : {}),
        });
      }
    }
    return modelEntries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Catalog metadata for qualified (`provider/model`) ids, independent of
   * the key's allowlist so capabilities mirror even when only the alias is
   * allowed.
   */
  private async modelMetadataById(
    tenantId: string,
    ids: readonly string[],
  ): Promise<Map<string, ModelMetadata>> {
    const wanted = new Map<string, string>();
    for (const id of ids) {
      const slash = id.indexOf("/");
      if (slash <= 0) continue;
      wanted.set(id, id);
    }
    const out = new Map<string, ModelMetadata>();
    if (wanted.size === 0) return out;
    const pairs = [...wanted.keys()].map((id) => {
      const slash = id.indexOf("/");
      return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
    });
    const rows = await this.db
      .select({
        providerId: models.providerId,
        modelId: models.modelId,
        contextLimit: models.contextLimit,
        outputLimit: models.outputLimit,
        modalities: models.modalities,
      })
      .from(models)
      .where(
        and(
          eq(models.enabled, true),
          or(
            ...pairs.map((p) => and(eq(models.providerId, p.provider), eq(models.modelId, p.model))),
          ),
        ),
      );
    for (const row of rows) {
      out.set(`${row.providerId}/${row.modelId}`, {
        contextLimit: row.contextLimit,
        outputLimit: row.outputLimit,
        modalities: row.modalities,
      });
    }
    void tenantId;
    return out;
  }

  async getPublicModelDetail(
    targetId: string,
    tenantId: string | null,
    snapshot: ApiKeyAuthorizationSnapshot,
    modelPrefix?: string,
  ): Promise<AllowedModelEntry | undefined> {
    if (targetId.includes("/")) {
      const slashIndex = targetId.indexOf("/");
      const targetProvider = targetId.slice(0, slashIndex);
      const targetModel = targetId.slice(slashIndex + 1);
      const rows = await this.db
        .select({
          providerId: models.providerId,
          modelId: models.modelId,
          contextLimit: models.contextLimit,
          outputLimit: models.outputLimit,
          modalities: models.modalities,
        })
        .from(models)
        .innerJoin(providers, eq(models.providerId, providers.id))
        .where(
          and(
            eq(models.enabled, true),
            eq(providers.enabled, true),
            eq(models.providerId, targetProvider),
            eq(models.modelId, targetModel),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (
        row &&
        (matchesModelPrefix(modelPrefix, row.modelId, `${row.providerId}/${row.modelId}`) ||
          isModelAllowed(snapshot, row.modelId) ||
          isModelAllowed(snapshot, `${row.providerId}/${row.modelId}`)) &&
        isProviderAllowed(snapshot, row.providerId) &&
        (isModelAllowed(snapshot, row.modelId) ||
          isModelAllowed(snapshot, `${row.providerId}/${row.modelId}`))
      ) {
        return {
          id: `${row.providerId}/${row.modelId}`,
          object: "model" as const,
          created: Math.floor(Date.now() / 1000),
          owned_by: row.providerId,
          ...(row.contextLimit != null ? { context_length: row.contextLimit } : {}),
          ...(row.outputLimit != null ? { max_completion_tokens: row.outputLimit } : {}),
          ...(row.modalities ? { capabilities: row.modalities } : {}),
        };
      }
      return undefined;
    }
    const data = await this.listPublicModels(tenantId, snapshot, modelPrefix);
    return data.find((m) => m.id === targetId);
  }
}
