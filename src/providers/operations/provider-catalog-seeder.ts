/** Durable materialization of bundled provider model metadata. */
import { and, eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { models } from "../../persistence/schema";
import type { ModelDefinition } from "../provider-registry";

/** Persists compiled provider model metadata and reconciles drifted capability flags. */
export async function seedBundledModels(
  db: CartethyiaDatabase,
  builtinModels: ReadonlyMap<string, readonly ModelDefinition[]>,
): Promise<void> {
  for (const [providerId, definitions] of builtinModels) {
    if (definitions.length === 0) continue;
    // Drop builtin rows the current catalog no longer declares, including rows
    // whose model id is still present but whose endpoint path drifted (e.g. a
    // provider that moved from `/chat/completions` to `/v2/chat/completions`).
    // The unique key is (provider, model, endpoint), so a changed endpoint
    // would otherwise insert a second row and leave the stale route behind —
    // the model list would then show duplicates and probes could hit the dead
    // path. Composite `NOT IN` keeps exactly the (model, endpoint) pairs the
    // catalog owns.
    const pairs = definitions.map(
      (definition) => sql`(${definition.modelId}, ${definition.endpointPath})`,
    );
    await db
      .delete(models)
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.source, "builtin"),
          sql`(${models.modelId}, ${models.endpointPath}) NOT IN (${sql.join(pairs, sql`, `)})`,
        ),
      );
  }
  const now = new Date();
  const seen = new Set<string>();
  const rows = [...builtinModels.entries()].flatMap(([providerId, definitions]) =>
    definitions.flatMap((definition) => {
      const key = `${providerId}\u0000${definition.modelId}\u0000${definition.endpointPath}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          providerId,
          modelId: definition.modelId,
          wireFamily: definition.wireFamily,
          endpointPath: definition.endpointPath,
          contextLimit: definition.contextLimit,
          outputLimit: definition.outputLimit,
          modalities: definition.modalities,
          reasoning: definition.reasoning,
          toolCall: definition.toolCall,
          webSearch: definition.webSearch,
          cost: definition.cost,
          source: "builtin",
          sourceUpdatedAt: now,
          enabled: true,
        },
      ];
    }),
  );
  if (rows.length === 0) return;
  // Reconcile static metadata on conflict rather than skipping: capability
  // flags (toolCall/reasoning/webSearch), wire family, limits, and cost can
  // drift on a pre-existing row (e.g. a discovery seeded `tool_call=false`
  // before the static catalog was corrected). `source` is forced back to
  // `builtin`: a fetch upsert may have flipped a builtin row to `discovered`,
  // and the static catalog owns these ids. `enabled` is operator-owned and
  // must never be reset here.
  await db.insert(models).values(rows).onConflictDoUpdate({
    target: [models.providerId, models.modelId, models.endpointPath],
    set: {
      wireFamily: sql`excluded.wire_family`,
      endpointPath: sql`excluded.endpoint_path`,
      contextLimit: sql`excluded.context_limit`,
      outputLimit: sql`excluded.output_limit`,
      modalities: sql`excluded.modalities`,
      reasoning: sql`excluded.reasoning`,
      toolCall: sql`excluded.tool_call`,
      webSearch: sql`excluded.web_search`,
      cost: sql`excluded.cost`,
      source: sql`'builtin'`,
      sourceUpdatedAt: sql`excluded.source_updated_at`,
    },
  });
}
