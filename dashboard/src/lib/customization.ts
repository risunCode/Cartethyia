import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  applyConsoleTheme,
  CONSOLE_THEME_KEY,
  parseConsoleTheme,
} from "./theme";

export type CustomAssetKind = "image" | "video";
export type ThemeChoice = "system" | "light" | "dark";
export type AmbientGlowChoice = "on" | "off";

export interface CustomAsset {
  readonly kind: CustomAssetKind;
  readonly blob: Blob;
  readonly name: string;
}

export interface CustomizationSettings {
  readonly theme: ThemeChoice;
  readonly ambientGlow: AmbientGlowChoice;
  readonly backgroundAsset: CustomAsset | null;
  readonly backgroundEnabled: boolean;
  readonly backgroundOpacity: number;
  readonly backgroundBlur: number;
  readonly glassEnabled: boolean;
  readonly glassDepth: 1 | 2;
}

export interface BrandingSettings {
  readonly asset: CustomAsset | null;
}

export const MAX_CUSTOM_ASSET_BYTES = 200 * 1024 * 1024;
export const MAX_BRANDING_ASSET_BYTES = 25 * 1024 * 1024;

const DATABASE_NAME = "console-db";
const BRANDING_KEY = "branding";
const BRANDING_EVENT = "console-branding-change";
const STORE_NAME = "settings";
const RECORD_KEY = "current";
const CHANGE_EVENT = "console-customization-change";
const LOCALSTORAGE_GLOW_KEY = "console-ambient-glow";

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov"]);

const DEFAULTS: CustomizationSettings = {
  theme: "system",
  ambientGlow: "on",
  backgroundAsset: null,
  backgroundEnabled: false,
  backgroundOpacity: 21,
  backgroundBlur: 2,
  glassEnabled: false,
  glassDepth: 1,
};

// Branding cache — populated by loadBranding() and updated on write.
let brandingCached: CustomAsset | null | undefined;

function readBrandingCached(): CustomAsset | null {
  return brandingCached ?? null;
}

let cachedSettings: CustomizationSettings | null = null;
let hydrated = false;
let hydration: Promise<void> | null = null;
let saveTimer: number | undefined;

function isAsset(value: unknown): value is CustomAsset {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const blob = candidate.blob;
  const blobLike =
    typeof blob === "object" &&
    blob !== null &&
    typeof (blob as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof (blob as { size?: unknown }).size === "number";
  return (
    blobLike &&
    (candidate.kind === "image" || candidate.kind === "video") &&
    typeof candidate.name === "string"
  );
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function parseGlow(value: unknown): AmbientGlowChoice {
  return value === "off" ? "off" : "on";
}

function parseSettings(value: unknown): CustomizationSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const asset = isAsset(obj.backgroundAsset) ? obj.backgroundAsset : null;
  return {
    theme: parseConsoleTheme(obj.theme),
    ambientGlow: parseGlow(obj.ambientGlow),
    backgroundAsset: asset,
    backgroundEnabled: asset !== null && obj.backgroundEnabled !== false,
    backgroundOpacity: clamp(obj.backgroundOpacity, DEFAULTS.backgroundOpacity, 0, 100),
    backgroundBlur: clamp(obj.backgroundBlur, DEFAULTS.backgroundBlur, 0, 18),
    glassEnabled: obj.glassEnabled === true,
    glassDepth: obj.glassDepth === 2 ? 2 : 1,
  };
}
function applyDomAppearance(settings: CustomizationSettings): void {
  if (typeof document === "undefined") return;
  // Theme read/write/DOM-apply lives in lib/theme.ts (shared with index.html
  // bootstrap and Shell.tsx); glow remains owned here.
  applyConsoleTheme(settings.theme);
  document.documentElement.dataset.ambientGlow = settings.ambientGlow;
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open customization storage"));
  });
}

// Single cached connection to the main database, reused for the whole
// session instead of opening/closing an `IDBDatabase` per read or write —
// avoids `onupgradeneeded` races and connection churn under rapid setting
// changes (e.g. a slider drag firing many writes).
let mainDbConnection: Promise<IDBDatabase> | null = null;

function getMainDatabase(): Promise<IDBDatabase> {
  if (!mainDbConnection) {
    mainDbConnection = openDatabase(DATABASE_NAME).catch((error: unknown) => {
      mainDbConnection = null; // allow a retry on the next call
      throw error;
    });
  }
  return mainDbConnection;
}

/** Reads the settings record from the main database (cached connection). */
async function readDatabase(): Promise<CustomizationSettings | null> {
  try {
    const database = await getMainDatabase();
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(RECORD_KEY);
      request.onsuccess = () => resolve(parseSettings(request.result));
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read customization storage"));
    });
  } catch {
    return null;
  }
}

async function writeDatabase(settings: CustomizationSettings): Promise<void> {
  const database = await getMainDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(settings, RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not save customization storage"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Could not save customization storage"));
  });
}

function readSyncStorage(): Partial<CustomizationSettings> | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const storedTheme = window.localStorage.getItem(CONSOLE_THEME_KEY);
    const storedGlow = window.localStorage.getItem(LOCALSTORAGE_GLOW_KEY);
    return {
      ...(storedTheme ? { theme: parseConsoleTheme(storedTheme) } : {}),
      ...(storedGlow ? { ambientGlow: parseGlow(storedGlow) } : {}),
    };
  } catch {
    return null;
  }
}

async function hydrate(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    try {
      const stored = await readDatabase();
      const syncLocal = readSyncStorage();

      if (!hydrated) {
        cachedSettings = {
          ...DEFAULTS,
          ...(stored ?? {}),
          ...(syncLocal ?? {}),
        };
        hydrated = true;
        applyDomAppearance(cachedSettings);
        await writeDatabase(cachedSettings);
        window.dispatchEvent(new Event(CHANGE_EVENT));
      }
    } catch {
      cachedSettings ??= { ...DEFAULTS };
      applyDomAppearance(cachedSettings);
    }
  })();
  return hydration;
}

export function readCustomizationSettings(): CustomizationSettings {
  if (!cachedSettings) {
    const sync = readSyncStorage();
    cachedSettings = {
      ...DEFAULTS,
      ...(sync ?? {}),
    };
    applyDomAppearance(cachedSettings);
  }
  return cachedSettings;
}

export function saveCustomizationSettings(
  patch: Partial<CustomizationSettings>,
): CustomizationSettings {
  const next: CustomizationSettings = { ...readCustomizationSettings(), ...patch };
  cachedSettings = next;
  hydrated = true;
  applyDomAppearance(next);

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CONSOLE_THEME_KEY, next.theme);
      window.localStorage.setItem(LOCALSTORAGE_GLOW_KEY, next.ambientGlow);
    } catch {
      // Storage write error ignored
    }
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    const persistenceSensitiveChange =
      Object.prototype.hasOwnProperty.call(patch, "backgroundAsset") ||
      Object.prototype.hasOwnProperty.call(patch, "backgroundEnabled") ||
      Object.prototype.hasOwnProperty.call(patch, "backgroundOpacity") ||
      Object.prototype.hasOwnProperty.call(patch, "backgroundBlur");
    if (persistenceSensitiveChange) {
      // Asset/blob and visual controls must survive an immediate refresh. Do
      // not defer these writes behind the slider debounce window.
      void writeDatabase(next).catch(() => undefined);
    } else {
      saveTimer = window.setTimeout(() => {
        void writeDatabase(next).catch(() => undefined);
        saveTimer = undefined;
      }, 250);
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
  return next;
}

export function useCustomizationSettings(): [
  CustomizationSettings,
  Dispatch<SetStateAction<Partial<CustomizationSettings>>>,
] {
  const [settings, setSettings] = useState(readCustomizationSettings);
  useEffect(() => {
    let active = true;
    void hydrate().then(() => {
      if (active) setSettings(readCustomizationSettings());
    });
    const sync = () => setSettings(readCustomizationSettings());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      active = false;
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);
  const update: Dispatch<SetStateAction<Partial<CustomizationSettings>>> = (patch) => {
    const value = typeof patch === "function" ? patch(readCustomizationSettings()) : patch;
    setSettings(saveCustomizationSettings(value));
  };
  return [settings, update];
}

export function useCustomizationAssetUrl(asset: CustomAsset | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset) {
      setUrl(null);
      return undefined;
    }
    const next = URL.createObjectURL(asset.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [asset]);
  return url;
}

async function loadBranding(): Promise<void> {
  try {
    const database = await getMainDatabase();
    await new Promise<void>((resolve) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(BRANDING_KEY);
      request.onsuccess = () => {
        brandingCached = isAsset(request.result) ? request.result : null;
        resolve();
      };
      request.onerror = () => resolve();
    });
  } catch {
    brandingCached = null;
  }
}

async function persistBranding(asset: CustomAsset | null): Promise<void> {
  const database = await getMainDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    if (asset === null) transaction.objectStore(STORE_NAME).delete(BRANDING_KEY);
    else transaction.objectStore(STORE_NAME).put(asset, BRANDING_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save branding"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Could not save branding"));
  });
}

export function useCustomizationBranding(): [
  BrandingSettings,
  Dispatch<SetStateAction<BrandingSettings>>,
] {
  const [branding, setBranding] = useState<BrandingSettings>({ asset: null });
  useEffect(() => {
    let active = true;
    void loadBranding().then(() => {
      if (active) setBranding({ asset: readBrandingCached() });
    });
    const sync = () => setBranding({ asset: readBrandingCached() });
    window.addEventListener(BRANDING_EVENT, sync);
    return () => {
      active = false;
      window.removeEventListener(BRANDING_EVENT, sync);
    };
  }, []);
  const update: Dispatch<SetStateAction<BrandingSettings>> = (value) => {
    const next = typeof value === "function" ? value({ asset: brandingCached ?? null }) : value;
    brandingCached = next.asset;
    setBranding({ asset: next.asset });
    void persistBranding(next.asset).catch(() => undefined);
  };
  return [branding, update];
}

export function classifyCustomAssetFile(file: Pick<File, "name" | "type">): CustomAssetKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  const extension = file.name.toLowerCase().split(".").pop();
  return extension && VIDEO_EXTENSIONS.has(extension) ? "video" : null;
}
