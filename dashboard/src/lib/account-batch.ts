import { consolePost } from "./console-api";

export const ACCOUNT_IMPORT_CHUNK_SIZE = 500;

export interface AccountBatchResult {
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errors?: readonly string[];
}

interface AccountBatchCreatedResponse {
  readonly items: readonly unknown[];
}

type AccountBatchResponse = AccountBatchResult | AccountBatchCreatedResponse;

export interface AccountBatchOutcome {
  readonly created: number;
  readonly skipped: number;
  readonly errors?: readonly string[];
}

export interface AccountBatchItem {
  readonly credentialRef?: string;
  readonly label?: string;
  readonly enabled?: boolean;
}


const UNSAFE_BATCH_ERROR = /(?:token|credential|authorization|cookie|password|prompt|provider response|raw body)/i;
const SECRET_LIKE_REF = /^(?:sk-|pk-|eyJ|ghp_|xoxb-|bearer\s)/i;

function isOpaqueCredentialRef(value: string): boolean {
  return value.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(value) && !SECRET_LIKE_REF.test(value);
}

function toBatchItem(item: AccountBatchItem): { readonly credentialRef: string; readonly label: string; readonly enabled: boolean } {
  if (!item.credentialRef || !item.label || !isOpaqueCredentialRef(item.credentialRef)) {
    throw new Error("account batch requires a label and opaque credential reference");
  }
  return { credentialRef: item.credentialRef, label: item.label, enabled: item.enabled ?? true };
}

/** Sends bounded account metadata chunks without accepting raw credential material. */
export async function createAccountsInBatches(providerId: string, items: readonly AccountBatchItem[]): Promise<AccountBatchOutcome> {
  if (!providerId.trim()) throw new Error("account batch requires a provider");
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (let offset = 0; offset < items.length; offset += ACCOUNT_IMPORT_CHUNK_SIZE) {
    const chunk = items.slice(offset, offset + ACCOUNT_IMPORT_CHUNK_SIZE).map(toBatchItem);
    const response = await consolePost<AccountBatchResponse>(`/providers/${encodeURIComponent(providerId)}/accounts/batch`, { items: chunk });
    const result: AccountBatchResult = "items" in response
      ? { processed: response.items.length, succeeded: response.items.length, failed: 0 }
      : response;
    if (!Number.isSafeInteger(result.processed) || !Number.isSafeInteger(result.succeeded) || !Number.isSafeInteger(result.failed)
      || result.processed < 0 || result.succeeded < 0 || result.failed < 0
      || result.processed !== result.succeeded + result.failed
      || result.processed > chunk.length) {
      throw new Error("account batch response is invalid");
    }
    created += result.succeeded;
    skipped += result.failed;
    errors.push(...(result.errors ?? []).filter((error): error is string => typeof error === "string" && error.length <= 240 && !UNSAFE_BATCH_ERROR.test(error)));
    if (offset + chunk.length < items.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return errors.length > 0 ? { created, skipped, errors } : { created, skipped };
}
