import { getDb } from "../client";
import { listApiKeys, type ApiKeyPublic } from "./api-keys";

interface ShareLinkRow {
  api_key_id: string;
  token_hash: string;
  active: number;
}

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(token);
  return hasher.digest("hex");
}

/** Creates a public monitoring token for one active API key. */
export function createShareLink(apiKeyId: string): { token: string; key: ApiKeyPublic } | null {
  const key = listApiKeys().find((item) => item.id === apiKeyId && item.active);
  if (!key) return null;

  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = new Date().toISOString();
  getDb().query(
    "INSERT INTO share_links (id, api_key_id, token_hash, active, created_at) VALUES (?, ?, ?, 1, ?)",
  ).run(crypto.randomUUID(), apiKeyId, hashToken(token), now);
  return { token, key };
}

/** Resolves a public monitoring token to its active API key and records a view. */
export function resolveShareLink(token: string): ApiKeyPublic | null {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const row = getDb().query(
    "SELECT api_key_id, token_hash, active FROM share_links WHERE token_hash = ? AND active = 1",
  ).get(hashToken(token)) as ShareLinkRow | null;
  if (!row) return null;
  getDb().query("UPDATE share_links SET last_viewed_at = ? WHERE token_hash = ?").run(new Date().toISOString(), row.token_hash);
  return listApiKeys().find((key) => key.id === row.api_key_id && key.active) ?? null;
}
