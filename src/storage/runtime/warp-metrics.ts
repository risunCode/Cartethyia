import { Database } from "bun:sqlite";
import type { WriteBuffer } from "./write-buffer";

export interface WarpMetricRow {
  readonly id: number;
  readonly accountId: string;
  readonly label: string;
  readonly pid: number;
  readonly socksPort: number;
  readonly rssKb: number;
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly healthy: boolean;
  readonly egressIp: string | null;
  readonly collectedAt: string;
}

export interface WarpMetricsSummary {
  readonly totalRssMb: number;
  readonly totalRxMb: number;
  readonly totalTxMb: number;
  readonly totalBandwidthMb: number;
  readonly runningCount: number;
  readonly healthyCount: number;
}

export interface WarpMetricsRepository {
  record(row: Omit<WarpMetricRow, "id">): void;
  latest(): readonly WarpMetricRow[];
  summary(): WarpMetricsSummary;
  page(cursor: number | null, limit: number): { readonly items: readonly WarpMetricRow[]; readonly nextCursor: number | null };
  prune(maxRows: number): void;
}

export function createWarpMetricsRepository(buffer: WriteBuffer, getDb: () => Database): WarpMetricsRepository {
  const toRow = (row: Record<string, unknown>): WarpMetricRow => ({
    id: Number(row.id),
    accountId: String(row.account_id),
    label: String(row.label),
    pid: Number(row.pid),
    socksPort: Number(row.socks_port),
    rssKb: Number(row.rss_kb),
    rxBytes: Number(row.rx_bytes),
    txBytes: Number(row.tx_bytes),
    healthy: Number(row.healthy) === 1,
    egressIp: typeof row.egress_ip === "string" ? row.egress_ip : null,
    collectedAt: String(row.collected_at),
  });

  return {
    record(row): void {
      buffer.enqueue(
        "INSERT INTO warp_metrics (account_id, label, pid, socks_port, rss_kb, rx_bytes, tx_bytes, healthy, egress_ip, collected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row.accountId, row.label, row.pid, row.socksPort, row.rssKb, row.rxBytes, row.txBytes, row.healthy ? 1 : 0, row.egressIp, row.collectedAt],
      );
    },
    latest(): readonly WarpMetricRow[] {
      const rows = getDb().query("SELECT * FROM warp_metrics WHERE id IN (SELECT MAX(id) FROM warp_metrics GROUP BY account_id) ORDER BY collected_at DESC").all() as Record<string, unknown>[];
      return rows.map(toRow);
    },
    summary(): WarpMetricsSummary {
      const rows = getDb().query("SELECT rss_kb, rx_bytes, tx_bytes FROM warp_metrics WHERE id IN (SELECT MAX(id) FROM warp_metrics GROUP BY account_id) AND healthy = 1 AND collected_at >= datetime('now', '-1 minute')").all() as Record<string, unknown>[];
      let totalRssKb = 0;
      let totalRx = 0;
      let totalTx = 0;
      for (const row of rows) {
        totalRssKb += Number(row.rss_kb);
        totalRx += Number(row.rx_bytes);
        totalTx += Number(row.tx_bytes);
      }
      return {
        totalRssMb: Math.round(totalRssKb / 1024),
        totalRxMb: Math.round(totalRx / (1024 * 1024)),
        totalTxMb: Math.round(totalTx / (1024 * 1024)),
        totalBandwidthMb: Math.round((totalRx + totalTx) / (1024 * 1024)),
        runningCount: rows.length,
        healthyCount: rows.length,
      };
    },
    page(cursor, limit): { readonly items: readonly WarpMetricRow[]; readonly nextCursor: number | null } {
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 50);
      const rows = cursor === null
        ? getDb().query("SELECT * FROM warp_metrics ORDER BY id DESC LIMIT ?").all(bounded) as Record<string, unknown>[]
        : getDb().query("SELECT * FROM warp_metrics WHERE id < ? ORDER BY id DESC LIMIT ?").all(cursor, bounded) as Record<string, unknown>[];
      const items = rows.map(toRow);
      return { items, nextCursor: items.length === bounded ? items.at(-1)?.id ?? null : null };
    },
    prune(maxRows): void {
      const count = getDb().query("SELECT COUNT(*) AS n FROM warp_metrics").get() as { n: number } | null;
      if ((count?.n ?? 0) <= maxRows * 1.5) return;
      getDb().query("DELETE FROM warp_metrics WHERE id <= (SELECT id FROM warp_metrics ORDER BY id DESC LIMIT 1 OFFSET ?)").run(maxRows);
    },
  };
}
