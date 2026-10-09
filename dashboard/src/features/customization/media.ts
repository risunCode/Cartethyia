/**
 * The custom background blob.
 *
 * IndexedDB rather than `localStorage`: a video or a full-resolution image
 * blows past the ~5 MB storage quota immediately, and a quota failure there
 * would also wipe the settings stored beside it. One database, one store, one
 * record — there is only ever a single background.
 */

const DB_NAME = "cartethyia.customization";
const STORE = "media";
const RECORD_KEY = "background";
const DB_VERSION = 1;

export interface BackgroundMedia {
  readonly blob: Blob;
  readonly kind: "image" | "video";
  /** Object URL for the current blob. Revoke it when the blob changes. */
  readonly url: string;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open the media database."));
  return promise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("The media database rejected the request."));
  return promise;
}

interface StoredMedia {
  readonly blob: Blob;
  readonly kind: "image" | "video";
}

function transactionDone(tx: IDBTransaction, failure: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error(failure));
  return promise;
}

export async function readBackgroundMedia(): Promise<BackgroundMedia | null> {
  const db = await openDb();
  try {
    const stored = await requestToPromise(
      db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY),
    );
    if (!stored || !(stored as StoredMedia).blob) return null;
    const record = stored as StoredMedia;
    return { blob: record.blob, kind: record.kind, url: URL.createObjectURL(record.blob) };
  } finally {
    db.close();
  }
}

export async function writeBackgroundMedia(blob: Blob, kind: "image" | "video"): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ blob, kind } satisfies StoredMedia, RECORD_KEY);
    await transactionDone(tx, "Could not store the background.");
  } finally {
    db.close();
  }
}

export async function deleteBackgroundMedia(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(RECORD_KEY);
    await transactionDone(tx, "Could not remove the background.");
  } finally {
    db.close();
  }
}

/** Longest edge of the resized image. Past this, cover scaling gains nothing. */
const IMAGE_MAX_EDGE = 2560;
const IMAGE_QUALITY = 0.85;

/**
 * Downscales an image so a phone-camera original does not decode at full size
 * on every page. Keeps the aspect ratio; never upscales. Falls back to the
 * original blob when the browser cannot decode it.
 */
export async function shrinkBackgroundImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, IMAGE_MAX_EDGE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const resized = await canvasToBlob(canvas);
    return resized ?? file;
  } finally {
    bitmap.close();
  }
}
/** Bytes the upload will accept. The file stays on the user's device, so the
 *  cap is generous; past `BACKGROUND_WARN_BYTES` the page warns instead. */
export const BACKGROUND_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** Above this the decode and paint cost starts to show. Still accepted. */
export const BACKGROUND_WARN_BYTES = 256 * 1024 * 1024;
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  canvas.toBlob((blob) => resolve(blob), "image/webp", IMAGE_QUALITY);
  return promise;
}


export function mediaKind(file: File): "image" | "video" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}
