import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import type { ShareLinkRow } from "../mappers";
import type { ShareLinkRecord, ShareLinkRepository } from "../records";
export function createConsoleShareLinkRepository(db: () => Database): ShareLinkRepository {
  const toRecord = (row: ShareLinkRow): ShareLinkRecord => ({
    id: row.id,
    apiKeyId: row.api_key_id,
    tokenHash: row.token_hash,
    kind: row.kind === "setup" ? "setup" : "monitor",
    active: row.active === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    lastViewedAt: row.last_viewed_at,
  });
  return {
    getByTokenHash(tokenHash: string): ShareLinkRecord | null {
      const row = db().query("SELECT * FROM share_links WHERE token_hash = ?").get(tokenHash) as ShareLinkRow | null;
      return row ? toRecord(row) : null;
    },
    listByApiKey(apiKeyId: string): ShareLinkRecord[] {
      return (db().query("SELECT * FROM share_links WHERE api_key_id = ? ORDER BY created_at DESC").all(apiKeyId) as ShareLinkRow[]).map(toRecord);
    },
    create(input): ShareLinkRecord {
      const now = nowIso();
      db().query("INSERT INTO share_links (id, api_key_id, token_hash, kind, active, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.id, input.apiKeyId, input.tokenHash, input.kind ?? "monitor", input.active === false ? 0 : 1, now, input.expiresAt ?? null);
      return toRecord(db().query("SELECT * FROM share_links WHERE id = ?").get(input.id) as ShareLinkRow);
    },
    patchActive(id: string, active: boolean): ShareLinkRecord | null {
      const result = db().query("UPDATE share_links SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
      if (result.changes === 0) return null;
      return toRecord(db().query("SELECT * FROM share_links WHERE id = ?").get(id) as ShareLinkRow);
    },
    consumeSetup(id: string, now: string): ShareLinkRecord | null {
      const result = db().query("UPDATE share_links SET active = 0, used_at = ? WHERE id = ? AND kind = 'setup' AND active = 1 AND (expires_at IS NULL OR expires_at > ?)").run(now, id, now);
      if (result.changes === 0) return null;
      return toRecord(db().query("SELECT * FROM share_links WHERE id = ?").get(id) as ShareLinkRow);
    },
    touch(id: string): void {
      db().query("UPDATE share_links SET last_viewed_at = ? WHERE id = ?").run(nowIso(), id);
    },
    delete(id: string): boolean {
      const result = db().query("DELETE FROM share_links WHERE id = ?").run(id);
      return result.changes > 0;
    },
  };
}

