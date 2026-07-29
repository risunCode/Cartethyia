/**
 * Bootstrap — idempotent first-use setup: settings row (password hash + JWT
 * secret) and the optional bootstrap proxy API key.
 */

import { getConsoleEnv } from "./env";
import { ensureSettings } from "./db/repos/settings";
import { createApiKey, findApiKeyBySecret, listApiKeys } from "./db/repos/api-keys";
import { addAuditEvent } from "./db/repos/audit";
import { seedDefaultSanitizerRules } from "./db/repos/sanitizer-rules";

let done = false;

export async function ensureConsoleBootstrap(): Promise<void> {
  if (done) return;
  const env = getConsoleEnv();
  if (!env.enabled) return;
  await ensureSettings();
  seedDefaultSanitizerRules();
  if (env.bootstrapKey && !findApiKeyBySecret(env.bootstrapKey)) {
    if (!listApiKeys().some((k) => k.name === env.bootstrapKeyName)) {
      // Store the operator-provided key by hash; never log or return it.
      const created = createApiKey({ name: env.bootstrapKeyName });
      if (!("error" in created)) {
        // Replace generated secret with the provided one (hash only).
        const { getDb } = await import("./db/client");
        const { hashApiKey } = await import("./db/repos/api-keys");
        getDb().query("UPDATE api_keys SET key_hash = ?, key_prefix = ? WHERE id = ?").run(
          hashApiKey(env.bootstrapKey),
          env.bootstrapKey.slice(0, 12),
          created.record.id
        );
      }
      addAuditEvent("bootstrap.api_key", { name: env.bootstrapKeyName });
    }
  }
  done = true;
}

/** Test-only: allow re-running bootstrap after a DB reset. */
export function resetBootstrapForTests(): void {
  done = false;
}
