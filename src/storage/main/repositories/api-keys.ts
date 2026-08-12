import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import { toApiKeyPublic, type ApiKeyRow } from "../mappers";
import type { ApiKeyCreateInput, ApiKeyPublic, ApiKeyRepository, ApiKeyUpdateInput } from "../records";


export function createConsoleApiKeyRepository(db: () => Database): ApiKeyRepository {
  const pendingTouches = new Set<string>();
  const keyCache = new Map<string, { readonly rows: readonly ApiKeyRow[]; readonly expiresAtMs: number }>();
  const API_KEY_CACHE_TTL_MS = 250;
  const MAX_CACHED_PREFIXES = 1_024;
  let touchTimer: Timer | null = null;

  const invalidateKeyCache = (): void => {
    keyCache.clear();
  };

  const getBySecret = (key: string): ApiKeyPublic | null => {
    const prefix = key.slice(0, Math.min(8, key.length));
    const now = Date.now();
    const cached = keyCache.get(prefix);
    const candidates = cached !== undefined && cached.expiresAtMs > now
      ? cached.rows
      : db().query("SELECT * FROM api_keys WHERE key LIKE ? AND active = 1 AND revoked_at IS NULL").all(`${prefix}%`) as ApiKeyRow[];
    if (cached === undefined || cached.expiresAtMs <= now) {
      keyCache.set(prefix, { rows: candidates, expiresAtMs: now + API_KEY_CACHE_TTL_MS });
      if (keyCache.size > MAX_CACHED_PREFIXES) {
        const oldest = keyCache.keys().next().value;
        if (typeof oldest === "string") keyCache.delete(oldest);
      }
    }
    for (const candidate of candidates) {
      if (candidate.key.length !== key.length) continue;
      try {
        if (crypto.timingSafeEqual(Buffer.from(candidate.key), Buffer.from(key))) return toApiKeyPublic(candidate);
      } catch {
        // Length mismatch is already checked; ignore malformed candidate data.
      }
    }
    return null;
  };


  const flushTouches = (): void => {
    if (touchTimer) {
      clearTimeout(touchTimer);
      touchTimer = null;
    }
    if (pendingTouches.size === 0) return;
    const ids = [...pendingTouches];
    pendingTouches.clear();
    const now = nowIso();
    const apply = db().transaction((rows: string[]) => {
      for (const id of rows) db().query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, id);
    });
    apply(ids);
  };

  return {
    list(): ApiKeyPublic[] {
      return (db().query("SELECT * FROM api_keys ORDER BY created_at DESC").all() as ApiKeyRow[]).map(toApiKeyPublic);
    },
    getById(id: string): ApiKeyPublic | null {
      const row = db().query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
      return row ? toApiKeyPublic(row) : null;
    },
    getBySecret,
    credential(id: string): string | null {
      const row = db().query("SELECT key FROM api_keys WHERE id = ?").get(id) as { key: string } | null;
      return row?.key ?? null;
    },
    create(input: ApiKeyCreateInput): ApiKeyPublic {
      const now = nowIso();
      db().query(
        "INSERT INTO api_keys (id, name, key, key_prefix, active, rate_limit_rpm, daily_token_limit, monthly_token_limit, one_time_token_limit, max_concurrent_requests, provider_allowlist, model_allowlist, model_denylist, disable_remote_mapping, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.name, input.key, input.keyPrefix, input.rateLimitRpm ?? null, input.dailyTokenLimit ?? null, input.monthlyTokenLimit ?? null, input.oneTimeTokenLimit ?? null, input.maxConcurrentRequests ?? null, input.providerAllowlist ?? null, input.modelAllowlist ?? null, input.modelDenylist ?? null, input.disableRemoteMapping ? 1 : 0, now);
      const row = db().query("SELECT * FROM api_keys WHERE id = ?").get(input.id) as ApiKeyRow;
      invalidateKeyCache();
      return toApiKeyPublic(row);
    },
    update(id: string, patch: ApiKeyUpdateInput): ApiKeyPublic | null {
      const existing = db().query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
      if (!existing) return null;
      const fields: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.key !== undefined) {
        fields.push("key = ?", "key_prefix = ?", "active = ?", "revoked_at = ?");
        values.push(patch.key, patch.key.slice(0, Math.min(12, patch.key.length)), 1, null);
      }
      if (patch.rateLimitRpm !== undefined) {
        fields.push("rate_limit_rpm = ?");
        values.push(patch.rateLimitRpm);
      }
      if (patch.dailyTokenLimit !== undefined) {
        fields.push("daily_token_limit = ?");
        values.push(patch.dailyTokenLimit);
      }
      if (patch.monthlyTokenLimit !== undefined) {
        fields.push("monthly_token_limit = ?");
        values.push(patch.monthlyTokenLimit);
      }
      if (patch.quoteBigText !== undefined) {
        fields.push("quote_big_text = ?");
        values.push(patch.quoteBigText);
      }
      if (patch.quoteSubText !== undefined) {
        fields.push("quote_sub_text = ?");
        values.push(patch.quoteSubText);
      }
      if (patch.quoteBody !== undefined) {
        fields.push("quote_body = ?");
        values.push(patch.quoteBody);
      }
      if (patch.oneTimeTokenLimit !== undefined) {
        fields.push("one_time_token_limit = ?");
        values.push(patch.oneTimeTokenLimit);
      }
      if (patch.maxConcurrentRequests !== undefined) {
        fields.push("max_concurrent_requests = ?");
        values.push(patch.maxConcurrentRequests);
      }
      if (patch.providerAllowlist !== undefined) {
        fields.push("provider_allowlist = ?");
        values.push(patch.providerAllowlist);
      }
      if (patch.modelAllowlist !== undefined) {
        fields.push("model_allowlist = ?");
        values.push(patch.modelAllowlist);
      }
      if (patch.modelDenylist !== undefined) {
        fields.push("model_denylist = ?");
        values.push(patch.modelDenylist);
      }
      if (patch.disableRemoteMapping !== undefined) {
        fields.push("disable_remote_mapping = ?");
        values.push(patch.disableRemoteMapping ? 1 : 0);
      }
      if (patch.active !== undefined) {
        fields.push("active = ?");
        values.push(patch.active ? 1 : 0);
      }
      if (fields.length === 0) return toApiKeyPublic(existing);
      db().query(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
      invalidateKeyCache();
      const row = db().query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null;
      return row ? toApiKeyPublic(row) : null;
    },
    revoke(id: string): boolean {
      const result = db().query("UPDATE api_keys SET active = 0, revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), id);
      if (result.changes > 0) invalidateKeyCache();
      return result.changes > 0;
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM api_keys WHERE id = ?").run(id);
      if (result.changes > 0) invalidateKeyCache();
      return result.changes > 0;
    },
    touch(id: string): void {
      pendingTouches.add(id);
      if (pendingTouches.size >= 200) {
        flushTouches();
        return;
      }
      if (!touchTimer) {
        touchTimer = setTimeout(flushTouches, 30_000);
        touchTimer.unref?.();
      }
    },
    flushTouches,
    sumOneTimeTokensUsed(id: string): number {
      const row = db().query("SELECT one_time_tokens_used FROM api_keys WHERE id = ?").get(id) as { one_time_tokens_used: number } | null;
      return row?.one_time_tokens_used ?? 0;
    },
    consumeOneTimeTokens(id: string, tokens: number): void {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      db().query("UPDATE api_keys SET one_time_tokens_used = MIN(one_time_token_limit, one_time_tokens_used + ?) WHERE id = ? AND one_time_token_limit IS NOT NULL").run(Math.floor(tokens), id);
      invalidateKeyCache();
    },
  };
}

