export interface StoredShareKey {
  readonly key: string;
  readonly keyId: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
}

const DATABASE_NAME = "cartethyia-share-keys";
const STORE_NAME = "issued-keys";
const DATABASE_VERSION = 1;

type ShareKeyDatabase = IDBDatabase;

function openDatabase(): Promise<ShareKeyDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open share-key storage"));
  });
}

function validStoredShareKey(value: unknown): value is StoredShareKey {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.key === "string" &&
    typeof record.keyId === "string" &&
    typeof record.keyPrefix === "string" &&
    typeof record.createdAt === "string"
  );
}

export async function readStoredShareKey(token: string): Promise<StoredShareKey | null> {
  const database = await openDatabase();
  return await new Promise((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(token);
    request.onsuccess = () => resolve(validStoredShareKey(request.result) ? request.result : null);
    request.onerror = () => reject(request.error ?? new Error("Could not read share-key storage"));
  });
}

export async function writeStoredShareKey(token: string, value: StoredShareKey): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, token);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save share key in this browser"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Could not save share key in this browser"));
  });
}

export async function deleteStoredShareKey(token: string): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(token);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not clear share-key storage"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Could not clear share-key storage"));
  });
}
