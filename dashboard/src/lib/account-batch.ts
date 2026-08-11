import { apiPost } from "./api";

export const ACCOUNT_IMPORT_CHUNK_SIZE = 500;

interface AccountBatchResponse {
  readonly created: number;
  readonly skipped: number;
}

export interface AccountBatchItem {
  readonly name: string;
  readonly credentialKind: string;
  readonly credential: string;
}

/** Sends large credential imports in bounded, sequential chunks. */
export async function createAccountsInBatches(providerId: string, items: readonly AccountBatchItem[]): Promise<{ readonly created: number; readonly skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (let offset = 0; offset < items.length; offset += ACCOUNT_IMPORT_CHUNK_SIZE) {
    const chunk = items.slice(offset, offset + ACCOUNT_IMPORT_CHUNK_SIZE);
    const result = await apiPost<AccountBatchResponse>(`/providers/${encodeURIComponent(providerId)}/accounts/batch`, { items: chunk });
    created += result.created;
    skipped += result.skipped;
    if (offset + chunk.length < items.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { created, skipped };
}
