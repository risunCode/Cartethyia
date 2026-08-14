import { Database } from "bun:sqlite";
import { sanitizeMessage } from "../../application/contracts";
import { logCategoryOfScope, logCategorySql, type LogLevel } from "../../application/logging";
import { formatUtc, type ConsoleLogFilters, type ConsoleLogRepository, type ConsoleLogRow } from "./runtime";
import type { WriteBuffer } from "./write-buffer";

function toConsoleLogRow(row: { id: number; ts: string; level: string; scope: string; msg: string }): ConsoleLogRow {
  return { id: row.id, ts: row.ts, level: row.level as LogLevel, scope: row.scope, category: logCategoryOfScope(row.scope), msg: row.msg };
}

export function createConsoleLogRepository(buffer: WriteBuffer, getDb: () => Database): ConsoleLogRepository {
  const pushListeners = new Set<() => void>();
  const MAX_PUSH_LISTENERS = 64;
  return {
    push(level: LogLevel, scope: string, msg: string): void {
      const bounded = sanitizeMessage(msg);
      buffer.enqueue("INSERT INTO console_logs (ts, level, scope, msg) VALUES (?, ?, ?, ?)", [formatUtc(Date.now()), level, scope, bounded]);
      // Notify SSE subscribers immediately so the log stream doesn't wait for the next tick.
      for (const listener of pushListeners) listener();
    },
    clear(): void {
      buffer.flush();
      getDb().query("DELETE FROM console_logs").run();
    },
    list(filters: ConsoleLogFilters): { items: ConsoleLogRow[]; nextCursor: number | null } {
      const clauses: string[] = [logCategorySql(filters.category ?? "all")];
      const params: Array<string | number> = [];
      if (filters.cursor !== undefined) {
        clauses.push("id < ?");
        params.push(filters.cursor);
      }
      if (filters.level) {
        clauses.push("level = ?");
        params.push(filters.level);
      }
      if (filters.scope) {
        clauses.push("scope = ?");
        params.push(filters.scope);
      }
      const boundedLimit = Math.min(Math.max(Math.floor(filters.limit ?? 100), 1), 200);
      const rows = getDb()
        .query(`SELECT id, ts, level, scope, msg FROM console_logs WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`)
        .all(...params, boundedLimit + 1) as Array<{ id: number; ts: string; level: string; scope: string; msg: string }>;
      const hasMore = rows.length > boundedLimit;
      const visible = hasMore ? rows.slice(0, boundedLimit) : rows;
      const items = visible.map(toConsoleLogRow);
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },
    after(afterId: number, limit: number, filters: ConsoleLogFilters = {}): ConsoleLogRow[] {
      const cursor = Number.isFinite(afterId) ? Math.max(Math.floor(afterId), 0) : 0;
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
      const clauses = [logCategorySql(filters.category ?? "all"), "id > ?"];
      const params: Array<string | number> = [cursor];
      if (filters.level) {
        clauses.push("level = ?");
        params.push(filters.level);
      }
      if (filters.scope) {
        clauses.push("scope = ?");
        params.push(filters.scope);
      }
      const rows = getDb()
        .query(`SELECT id, ts, level, scope, msg FROM console_logs WHERE ${clauses.join(" AND ")} ORDER BY id ASC LIMIT ?`)
        .all(...params, bounded) as Array<{ id: number; ts: string; level: string; scope: string; msg: string }>;
      return rows.map(toConsoleLogRow);
    },
    onPush(listener: () => void): () => void {
      if (pushListeners.size >= MAX_PUSH_LISTENERS) {
        const oldest = pushListeners.values().next();
        if (!oldest.done) pushListeners.delete(oldest.value as () => void);
      }
      pushListeners.add(listener);
      return () => { pushListeners.delete(listener); };
    },
  };
}
