import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import { toProxy, type ProxyRow, type ProxySettingsRow } from "../mappers";
import type { ProxyCreateInput, ProxyPatchInput, ProxyRecord, ProxyRepository, ProxySettingsRecord, ProxyTestRecordInput } from "../records";
import { normalizeWebSearchPreference } from "../../../application/web-search-routing";


export function createConsoleProxyRepository(db: () => Database): ProxyRepository {
  const getSettingsRow = (): ProxySettingsRow | null => db().query("SELECT * FROM proxy_settings WHERE id = 1").get() as ProxySettingsRow | null;

  const toSettings = (row: ProxySettingsRow): ProxySettingsRecord => {
    let excludedProviders: readonly string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.excluded_providers_json);
      if (Array.isArray(parsed)) excludedProviders = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      // malformed legacy JSON — empty list
    }
    return {
      enabled: row.enabled === 1,
      excludedProviders,
      smartDynamicRouting: row.smart_dynamic_routing === 1,
      smartDynamicProxyCount: Math.max(1, Math.min(32, Math.round(row.smart_dynamic_proxy_count || 2))),
      routingPreset: row.routing_preset === "target-user" || row.routing_preset === "target-concurrent" ? row.routing_preset : "auto",
      targetConcurrent: Math.max(0, Math.min(10_000, Math.round(row.target_concurrent || 0))),
      webSearchPreference: normalizeWebSearchPreference(row.web_search_preference),
      updatedAt: row.updated_at,
    };
  };

  return {
    list(): ProxyRecord[] {
      return (db().query("SELECT * FROM proxies ORDER BY priority ASC, name ASC").all() as ProxyRow[]).map(toProxy);
    },
    get(id: string): ProxyRecord | null {
      const row = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      return row ? toProxy(row) : null;
    },
    create(input: ProxyCreateInput): ProxyRecord {
      const now = nowIso();
      db().query(
        "INSERT INTO proxies (id, name, protocol, is_relay, host, port, username, password, max_concurrency, priority, weight, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.id, input.name, input.protocol, input.isRelay ? 1 : 0, input.host, input.port, input.username ?? null, input.password ?? null, input.maxConcurrency ?? 8, input.priority ?? 100, Math.max(1, Math.min(1_000, Math.round(input.weight ?? 100))), input.active === false ? 0 : 1, now, now);
      return toProxy(db().query("SELECT * FROM proxies WHERE id = ?").get(input.id) as ProxyRow);
    },
    patch(id: string, patch: ProxyPatchInput): ProxyRecord | null {
      const existing = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      if (!existing) return null;
      const fields: string[] = [];
      const values: Array<string | number | null> = [];
      if (patch.name !== undefined) {
        fields.push("name = ?");
        values.push(patch.name);
      }
      if (patch.protocol !== undefined) {
        fields.push("protocol = ?");
        values.push(patch.protocol);
      }
      if (patch.host !== undefined) {
        fields.push("host = ?");
        values.push(patch.host);
      }
      if (patch.port !== undefined) {
        fields.push("port = ?");
        values.push(patch.port);
      }
      if (patch.username !== undefined) {
        fields.push("username = ?");
        values.push(patch.username);
      }
      if (patch.password !== undefined) {
        fields.push("password = ?");
        values.push(patch.password);
      }
      if (patch.isRelay !== undefined) {
        fields.push("is_relay = ?");
        values.push(patch.isRelay ? 1 : 0);
      }
      if (patch.maxConcurrency !== undefined) {
        fields.push("max_concurrency = ?");
        values.push(Math.max(1, Math.min(10_000, Math.round(patch.maxConcurrency))));
      }
      if (patch.priority !== undefined) {
        fields.push("priority = ?");
        values.push(patch.priority);
      }
      if (patch.weight !== undefined) {
        fields.push("weight = ?");
        values.push(Math.max(1, Math.min(1_000, Math.round(patch.weight))));
      }
      if (patch.active !== undefined) {
        fields.push("active = ?");
        values.push(patch.active ? 1 : 0);
      }
      if (patch.cooldownUntil !== undefined) {
        fields.push("cooldown_until = ?");
        values.push(patch.cooldownUntil);
      }
      if (patch.cooldownLevel !== undefined) {
        fields.push("cooldown_level = ?");
        values.push(patch.cooldownLevel);
      }
      if (patch.consecutiveUseCount !== undefined) {
        fields.push("consecutive_use_count = ?");
        values.push(patch.consecutiveUseCount);
      }
      if (patch.lastUsedAt !== undefined) {
        fields.push("last_used_at = ?");
        values.push(patch.lastUsedAt);
      }
      if (fields.length === 0) return toProxy(existing);
      db().query(`UPDATE proxies SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
      const row = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      return row ? toProxy(row) : null;
    },
    recordTest(id: string, result: ProxyTestRecordInput): ProxyRecord | null {
      const existing = db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | null;
      if (!existing) return null;
      if (result.ok) {
        db().query("UPDATE proxies SET last_test_at = ?, last_test_success_at = ?, last_test_success_latency_ms = ?, last_test_status_code = ?, updated_at = ? WHERE id = ?").run(result.testedAt, result.testedAt, result.latencyMs, result.statusCode, nowIso(), id);
      } else {
        db().query("UPDATE proxies SET last_test_at = ?, last_test_error_at = ?, last_test_error = ?, last_test_status_code = ?, updated_at = ? WHERE id = ?").run(result.testedAt, result.testedAt, result.error?.slice(0, 500) ?? "Connection failed", result.statusCode, nowIso(), id);
      }
      return toProxy(db().query("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow);
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM proxies WHERE id = ?").run(id);
      return result.changes > 0;
    },
    getSettings(): ProxySettingsRecord | null {
      const row = getSettingsRow();
      return row ? toSettings(row) : null;
    },
    patchSettings(patch: Partial<Omit<ProxySettingsRecord, "updatedAt">>): ProxySettingsRecord {
      const existing = getSettingsRow();
      const now = nowIso();
      if (!existing) {
        db().query("INSERT INTO proxy_settings (id, enabled, excluded_providers_json, smart_dynamic_routing, smart_dynamic_proxy_count, routing_preset, target_concurrent, web_search_preference, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)").run(
          patch.enabled === undefined ? 0 : patch.enabled ? 1 : 0,
          JSON.stringify(patch.excludedProviders ?? []),
          patch.smartDynamicRouting === undefined ? 0 : patch.smartDynamicRouting ? 1 : 0,
          Math.max(1, Math.min(32, Math.round(patch.smartDynamicProxyCount ?? 2))),
          patch.routingPreset === "target-user" || patch.routingPreset === "target-concurrent" ? patch.routingPreset : "auto",
          Math.max(0, Math.min(10_000, Math.round(patch.targetConcurrent ?? 0))),
          normalizeWebSearchPreference(patch.webSearchPreference),
          now,
        );
      } else {
        const fields: string[] = [];
        const values: Array<string | number> = [];
        if (patch.enabled !== undefined) {
          fields.push("enabled = ?");
          values.push(patch.enabled ? 1 : 0);
        }
        if (patch.excludedProviders !== undefined) {
          fields.push("excluded_providers_json = ?");
          values.push(JSON.stringify(patch.excludedProviders));
        }
        if (patch.smartDynamicRouting !== undefined) {
          fields.push("smart_dynamic_routing = ?");
          values.push(patch.smartDynamicRouting ? 1 : 0);
        }
        if (patch.smartDynamicProxyCount !== undefined) {
          fields.push("smart_dynamic_proxy_count = ?");
          values.push(Math.max(1, Math.min(32, Math.round(patch.smartDynamicProxyCount))));
        }
        if (patch.targetConcurrent !== undefined) {
          fields.push("target_concurrent = ?");
          values.push(Math.max(0, Math.min(10_000, Math.round(patch.targetConcurrent))));
        }
        if (patch.webSearchPreference !== undefined) {
          fields.push("web_search_preference = ?");
          values.push(normalizeWebSearchPreference(patch.webSearchPreference));
        }
        fields.push("updated_at = ?");
        values.push(now);
        db().query(`UPDATE proxy_settings SET ${fields.join(", ")} WHERE id = 1`).run(...values);
      }
      return toSettings(getSettingsRow() as ProxySettingsRow);
    },
  };
}
