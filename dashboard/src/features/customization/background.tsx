import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { Upload } from "lucide-react";
import { Button } from "../../components/ui/button";

export type CustomAssetKind = "image" | "video";

export interface CustomAsset {
  kind: CustomAssetKind;
  blob: Blob;
  name: string;
}

export interface CustomizationSettings {
  backgroundAsset: CustomAsset | null;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  backgroundBlur: number;
  backgroundPreferenceVersion: number;
  /** Performance mode — disables backdrop-blur, uses solid warm surfaces. */
  solidMode: boolean;
}

const DEFAULT_BACKGROUND_URL = `${import.meta.env.BASE_URL}macos-big-sur-apple-layers-fluidic-colorful-dark-wwdc-2020-3840x2160-1432.jpg`;
const BACKGROUND_PREFERENCE_VERSION = 1;
const DATABASE_NAME = "cartethyia-console-customization-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "settings";
const RECORD_KEY = "current";
// Keep Cartethyia isolated from other local apps that may reuse the older
// generic customization key.
const LEGACY_STORAGE_KEY = "cartethyia.console.customization";
const CHANGE_EVENT = "cartethyia-console-customization-change";
export const MAX_CUSTOM_ASSET_BYTES = 200 * 1024 * 1024;
const VIDEO_FILE_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov"]);

const DEFAULTS: CustomizationSettings = {
  backgroundAsset: null,
  backgroundEnabled: true,
  backgroundOpacity: 21,
  backgroundBlur: 2,
  backgroundPreferenceVersion: BACKGROUND_PREFERENCE_VERSION,
  solidMode: false,
};

let cachedSettings: CustomizationSettings | null = null;
let hasHydrated = false;
let saveTimer: number | undefined;
let hydrationPromise: Promise<CustomizationSettings> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCustomAsset(value: unknown): value is CustomAsset {
  if (!isRecord(value) || !(value.blob instanceof Blob)) return false;
  return (value.kind === "image" || value.kind === "video") && typeof value.name === "string";
}

function parseStoredSettings(value: unknown): CustomizationSettings | null {
  if (!isRecord(value)) return null;
  const backgroundAsset = isCustomAsset(value.backgroundAsset) ? value.backgroundAsset : null;
  const hasCurrentPreference = value.backgroundPreferenceVersion === BACKGROUND_PREFERENCE_VERSION;
  let backgroundEnabled = DEFAULTS.backgroundEnabled;
  if (backgroundAsset !== null || hasCurrentPreference) backgroundEnabled = value.backgroundEnabled !== false;
  return {
    backgroundAsset,
    backgroundEnabled,
    backgroundOpacity: typeof value.backgroundOpacity === "number" ? value.backgroundOpacity : DEFAULTS.backgroundOpacity,
    backgroundBlur: typeof value.backgroundBlur === "number" ? value.backgroundBlur : DEFAULTS.backgroundBlur,
    backgroundPreferenceVersion: BACKGROUND_PREFERENCE_VERSION,
    solidMode: typeof value.solidMode === "boolean" ? value.solidMode : DEFAULTS.solidMode,
  };
}

function openCustomizationDatabase(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  if (typeof indexedDB === "undefined") {
    reject(new Error("IndexedDB is unavailable."));
    return promise;
  }
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open customization storage."));
  return promise;
}

async function readFromDatabase(): Promise<CustomizationSettings | null> {
  const database = await openCustomizationDatabase();
  const { promise, resolve, reject } = Promise.withResolvers<CustomizationSettings | null>();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
  request.onsuccess = () => resolve(parseStoredSettings(request.result));
  request.onerror = () => reject(request.error ?? new Error("Could not read customization storage."));
  transaction.onerror = () => reject(transaction.error ?? new Error("Could not read customization storage."));
  transaction.onabort = () => reject(transaction.error ?? new Error("Could not read customization storage."));
  try {
    return await promise;
  } finally {
    database.close();
  }
}

async function writeToDatabase(settings: CustomizationSettings): Promise<void> {
  const database = await openCustomizationDatabase();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).put(settings, RECORD_KEY);
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error("Could not save customization storage."));
  transaction.onabort = () => reject(transaction.error ?? new Error("Could not save customization storage."));
  try {
    await promise;
  } finally {
    database.close();
  }
}

async function dataUrlToAsset(dataUrl: string, kind: CustomAssetKind, name: string): Promise<CustomAsset | null> {
  try {
    const response = await fetch(dataUrl);
    return { kind, blob: await response.blob(), name };
  } catch {
    return null;
  }
}

async function migrateLegacySettings(): Promise<CustomizationSettings> {
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!legacy) return { ...DEFAULTS };

  try {
    const parsed: unknown = JSON.parse(legacy);
    if (!isRecord(parsed)) return { ...DEFAULTS };
    const backgroundAsset = typeof parsed.backgroundDataUrl === "string"
      ? await dataUrlToAsset(parsed.backgroundDataUrl, "image", "migrated-background")
      : null;
    return {
      ...DEFAULTS,
      backgroundAsset,
      backgroundEnabled: backgroundAsset !== null ? parsed.backgroundEnabled !== false : DEFAULTS.backgroundEnabled,
      backgroundOpacity: typeof parsed.backgroundOpacity === "number" ? parsed.backgroundOpacity : DEFAULTS.backgroundOpacity,
      backgroundBlur: typeof parsed.backgroundBlur === "number" ? parsed.backgroundBlur : DEFAULTS.backgroundBlur,
    };
  } catch {
    return { ...DEFAULTS };
  } finally {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  }
}

async function hydrateCustomizationSettings(): Promise<CustomizationSettings> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const stored = await readFromDatabase();
      const next = stored ?? await migrateLegacySettings();
      // Only adopt the hydrated value if we haven't already cached a newer
      // one (user may have moved a slider while the async IDB read was in
      // flight — adopting the stale DB copy would snap the slider back).
      if (!hasHydrated) {
        cachedSettings = next;
        hasHydrated = true;
        await writeToDatabase(next);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        window.dispatchEvent(new Event(CHANGE_EVENT));
      }
      return cachedSettings ?? { ...DEFAULTS };
    } catch (error) {
      console.warn("Customization persistence unavailable.", error);
      cachedSettings ??= { ...DEFAULTS };
      return cachedSettings;
    }
  })();
  return hydrationPromise;
}

export function readCustomizationSettings(): CustomizationSettings {
  if (cachedSettings) return cachedSettings;
  cachedSettings = { ...DEFAULTS };
  return cachedSettings;
}

export function saveCustomizationSettings(patch: Partial<CustomizationSettings>): CustomizationSettings {
  const next = {
    ...readCustomizationSettings(),
    ...patch,
    backgroundPreferenceVersion: BACKGROUND_PREFERENCE_VERSION,
  };
  cachedSettings = next;
  // Mark as hydrated so the async IDB read doesn't snap the slider back
  // to the stale DB value after the user already moved it.
  hasHydrated = true;
  if (typeof window === "undefined") return next;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void writeToDatabase(next).catch((error: unknown) => console.warn("Could not persist customization settings.", error));
    saveTimer = undefined;
  }, 250);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

export function useCustomizationSettings(): [CustomizationSettings, (patch: Partial<CustomizationSettings>) => void] {
  const [settings, setSettings] = useState<CustomizationSettings>(readCustomizationSettings);
  useEffect(() => {
    void hydrateCustomizationSettings().then(setSettings);
    const sync = () => setSettings(readCustomizationSettings());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);
  return [settings, (patch) => setSettings(saveCustomizationSettings(patch))];
}

export function useCustomizationAssetUrl(asset: CustomAsset | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!asset) {
      setUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(asset.blob);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [asset]);
  return url;
}

export function CustomAtmosphere() {
  const [settings] = useCustomizationSettings();
  const customBackgroundUrl = useCustomizationAssetUrl(settings.backgroundAsset);
  const backgroundUrl = settings.backgroundAsset ? customBackgroundUrl : DEFAULT_BACKGROUND_URL;

  // Apply solid-mode data attribute to <html> — CSS overrides .glass to use
  // solid warm surfaces with no backdrop-filter (eliminates GPU blur lag).
  useEffect(() => {
    if (settings.solidMode) {
      document.documentElement.setAttribute("data-glass", "off");
    } else {
      document.documentElement.removeAttribute("data-glass");
    }
  }, [settings.solidMode]);

  if (!backgroundUrl || !settings.backgroundEnabled) return null;

  const backgroundStyle = {
    opacity: settings.backgroundOpacity / 100,
    "--custom-bg-blur": `${settings.backgroundBlur}px`,
  } as CSSProperties;

  return settings.backgroundAsset?.kind === "video" ? (
    <video
      className="custom-background-layer"
      src={backgroundUrl}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      tabIndex={-1}
      aria-hidden="true"
      style={backgroundStyle}
    />
  ) : (
    <div className="custom-background-layer" aria-hidden="true" style={{ ...backgroundStyle, backgroundImage: `url(${backgroundUrl})` }} />
  );
}

export function classifyCustomAssetFile(file: Pick<File, "name" | "type">): CustomAssetKind | null {
  const mediaType = file.type.toLowerCase();
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  const extension = file.name.toLowerCase().split(".").pop();
  return extension !== undefined && VIDEO_FILE_EXTENSIONS.has(extension) ? "video" : null;
}

function isOversized(file: File): boolean {
  return file.size > MAX_CUSTOM_ASSET_BYTES;
}

function AssetLimitNotice({ allowOversize, onChange }: { allowOversize: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg border border-[var(--orange)] bg-[rgba(255,159,10,0.08)] px-2 py-1.5 text-[10.5px] text-[var(--text-2)]">
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 font-semibold text-[var(--orange)]">
        <input type="checkbox" checked={allowOversize} onChange={(event) => onChange(event.target.checked)} className="size-3.5 accent-[var(--orange)]" />
        <span>Allow files over 200&nbsp;MB</span>
      </label>
      <span className="leading-4">Large media can use more browser memory and slow previews.</span>
    </div>
  );
}

export function BackgroundUpload({ onError }: { onError: (message: string) => void }) {
  const [settings, setSettings] = useCustomizationSettings();
  const [allowOversize, setAllowOversize] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const kind = classifyCustomAssetFile(file);
    if (kind === null) {
      onError("Choose an image or video file (MP4, WebM, OGV, or MOV).");
      return;
    }
    if (isOversized(file) && !allowOversize) {
      onError("Media exceeds 200 MB. Check the warning option to continue.");
      return;
    }
    setSettings({
      backgroundAsset: { kind, blob: file, name: file.name },
      backgroundEnabled: true,
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <Button type="button" size="sm" onClick={() => inputRef.current?.click()}>
          <Upload size={14} aria-hidden="true" />
          {settings.backgroundAsset ? "Change override" : "Override built-in background"}
        </Button>
        <input ref={inputRef} type="file" accept="image/*,video/*,.mp4,.webm,.ogv,.mov" className="sr-only" onChange={handleFile} />
        <p className="text-[10.5px] text-[var(--text-3)]">Supports images and video: MP4, WebM, OGV, or MOV.</p>
      </div>
      <AssetLimitNotice allowOversize={allowOversize} onChange={setAllowOversize} />
    </div>
  );
}
