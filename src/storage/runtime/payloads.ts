import { Database } from "bun:sqlite";
import { formatUtc, type RuntimePayloadArtifact, type RuntimePayloadRecord, type RuntimePayloadRepository } from "./runtime";
import type { WriteBuffer } from "./write-buffer";

const PAYLOAD_COLUMNS = {
  client_request: ["client_request", "client_request_meta"],
  provider_request: ["provider_request", "provider_request_meta"],
  provider_response: ["provider_response", "provider_response_meta"],
  client_response: ["client_response", "client_response_meta"],
} as const;

export function createRuntimePayloadRepository(buffer: WriteBuffer, getDb: () => Database): RuntimePayloadRepository { return {
  save(requestId, kind, artifact): void {
    const [valueColumn, metaColumn] = PAYLOAD_COLUMNS[kind];
    const columns = ["client_request", "provider_request", "provider_response", "client_response", "client_request_meta", "provider_request_meta", "provider_response_meta", "client_response_meta"];
    const values = columns.map((column) => column === valueColumn ? artifact.text : column === metaColumn ? JSON.stringify({ truncated: artifact.truncated, originalBytes: artifact.originalBytes, capturedBytes: artifact.capturedBytes }) : null);
    const sql = `INSERT INTO request_payloads (request_id, ${columns.join(", ")}, created_at, updated_at) VALUES (?, ${columns.map(() => "?").join(", ")}, ?, ?) ON CONFLICT(request_id) DO UPDATE SET ${valueColumn} = excluded.${valueColumn}, ${metaColumn} = excluded.${metaColumn}, updated_at = excluded.updated_at`;
    const now = formatUtc(Date.now());
    buffer.enqueue(sql, [requestId, ...values, now, now]);
  },
  get(requestId): RuntimePayloadRecord | null {
    buffer.flush();
    const row = getDb().query("SELECT * FROM request_payloads WHERE request_id = ?").get(requestId) as Record<string, unknown> | null;
    if (row === null) return null;
    const artifact = (valueColumn: string, metaColumn: string): RuntimePayloadArtifact | null => {
      const text = typeof row[valueColumn] === "string" ? row[valueColumn] as string : null;
      if (text === null) return null;
      let meta: Partial<RuntimePayloadArtifact> = {};
      try { meta = JSON.parse(String(row[metaColumn] ?? "{}")) as Partial<RuntimePayloadArtifact>; } catch { /* malformed legacy metadata */ }
      return { text, truncated: meta.truncated === true, originalBytes: typeof meta.originalBytes === "number" ? meta.originalBytes : text.length, capturedBytes: typeof meta.capturedBytes === "number" ? meta.capturedBytes : text.length };
    };
    return {
      requestId,
      clientRequest: artifact("client_request", "client_request_meta"),
      providerRequest: artifact("provider_request", "provider_request_meta"),
      providerResponse: artifact("provider_response", "provider_response_meta"),
      clientResponse: artifact("client_response", "client_response_meta"),
    };
  },
}; }
