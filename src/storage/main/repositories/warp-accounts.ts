import { Database } from "bun:sqlite";
import { nowIso } from "../schema";
import type { WarpAccount, WarpAccountCreateData, WarpAccountRepository, WarpAccountUpdateData } from "../../../console/warp/types";

interface WarpAccountRow {
  id: string;
  label: string;
  device_id: string;
  access_token: string;
  license_key: string;
  private_key: string;
  address_v4: string;
  address_v6: string;
  public_key: string;
  endpoint: string;
  endpoint_port: number;
  dns: string;
  mtu: number;
  socks_port: number;
  enabled: number;
  running: number;
  pid: number | null;
  prefer_ipv6: number;
  custom_endpoint: string | null;
  persistent_keepalive: number;
  created_at: string;
  updated_at: string | null;
}

function toWarpAccount(row: WarpAccountRow): WarpAccount {
  return {
    id: row.id,
    label: row.label,
    deviceId: row.device_id,
    accessToken: row.access_token,
    licenseKey: row.license_key,
    privateKey: row.private_key,
    addressV4: row.address_v4,
    addressV6: row.address_v6,
    publicKey: row.public_key,
    endpoint: row.endpoint,
    endpointPort: row.endpoint_port,
    dns: row.dns,
    mtu: row.mtu,
    socksPort: row.socks_port,
    enabled: row.enabled === 1,
    running: row.running === 1,
    pid: row.pid,
    preferIpv6: row.prefer_ipv6 === 1,
    customEndpoint: row.custom_endpoint,
    persistentKeepalive: row.persistent_keepalive,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createConsoleWarpAccountRepository(db: () => Database): WarpAccountRepository { const get = (id: string): WarpAccount | null => {
  const row = db().query("SELECT * FROM warp_accounts WHERE id = ?").get(id) as WarpAccountRow | null;
  return row === null ? null : toWarpAccount(row);
};

return {
  async list(): Promise<readonly WarpAccount[]> {
    return (db().query("SELECT * FROM warp_accounts ORDER BY created_at ASC").all() as WarpAccountRow[]).map(toWarpAccount);
  },
  async get(id: string): Promise<WarpAccount | null> {
    return get(id);
  },
  async create(data: WarpAccountCreateData): Promise<WarpAccount> {
    const now = nowIso();
    db().query(
      "INSERT INTO warp_accounts (id, label, device_id, access_token, license_key, private_key, address_v4, address_v6, public_key, endpoint, endpoint_port, dns, mtu, socks_port, enabled, running, pid, prefer_ipv6, custom_endpoint, persistent_keepalive, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?, ?, NULL)",
    ).run(
      data.id,
      data.label.trim() || `Warp-${data.socksPort}`,
      data.deviceId,
      data.accessToken,
      data.licenseKey,
      data.privateKey,
      data.addressV4,
      data.addressV6,
      data.publicKey,
      data.endpoint,
      data.endpointPort,
      data.dns,
      data.mtu,
      data.socksPort,
      data.preferIpv6 === false ? 0 : 1,
      data.customEndpoint ?? null,
      Math.max(0, Math.min(120, Math.round(data.persistentKeepalive ?? 15))),
      now,
    );
    const created = get(data.id);
    if (created === null) throw new Error("Warp account was not persisted");
    return created;
  },
  async update(id: string, patch: Partial<WarpAccountUpdateData>): Promise<WarpAccount | null> {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.label !== undefined) {
      const label = patch.label.trim();
      if (label.length === 0) throw new Error("label cannot be empty");
      fields.push("label = ?");
      values.push(label);
    }
    if (patch.enabled !== undefined) {
      fields.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.socksPort !== undefined) {
      fields.push("socks_port = ?");
      values.push(Math.max(1, Math.min(65_535, Math.round(patch.socksPort))));
    }
    if (patch.preferIpv6 !== undefined) {
      fields.push("prefer_ipv6 = ?");
      values.push(patch.preferIpv6 ? 1 : 0);
    }
    if (patch.customEndpoint !== undefined) {
      fields.push("custom_endpoint = ?");
      values.push(patch.customEndpoint?.trim() || null);
    }
    if (patch.persistentKeepalive !== undefined) {
      fields.push("persistent_keepalive = ?");
      values.push(Math.max(0, Math.min(120, Math.round(patch.persistentKeepalive))));
    }
    if (fields.length === 0) return get(id);
    values.push(nowIso(), id);
    const result = db().query(`UPDATE warp_accounts SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`).run(...values);
    return result.changes === 0 ? null : get(id);
  },
  async remove(id: string): Promise<boolean> {
    return db().query("DELETE FROM warp_accounts WHERE id = ?").run(id).changes > 0;
  },
  async setRunning(id: string, running: boolean, pid: number | null): Promise<void> {
    db().query("UPDATE warp_accounts SET running = ?, pid = ?, updated_at = ? WHERE id = ?").run(running ? 1 : 0, pid, nowIso(), id);
  },
}; }
