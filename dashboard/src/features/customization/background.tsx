import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from "react";

export interface CustomizationSettings {
  backgroundDataUrl: string | null;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  backgroundBlur: number;
  locksEnabled: boolean;
  locksFrequency: number;
  seasonalItemDataUrl: string | null;
  seasonalItemSize: number;
}

const STORAGE_KEY = "cartethyia.customization";
const CHANGE_EVENT = "cartethyia-customization-change";
const DEFAULTS: CustomizationSettings = {
  backgroundDataUrl: null,
  backgroundEnabled: true,
  backgroundOpacity: 34,
  backgroundBlur: 2,
  locksEnabled: false,
  locksFrequency: 1,
  seasonalItemDataUrl: null,
  seasonalItemSize: 32,
};

let cachedSettings: CustomizationSettings | null = null;
let saveTimer: number | undefined;

export function readCustomizationSettings(): CustomizationSettings {
  if (cachedSettings) return cachedSettings;
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    cachedSettings = !parsed || typeof parsed !== "object" || Array.isArray(parsed)
      ? { ...DEFAULTS }
      : { ...DEFAULTS, ...(parsed as Partial<CustomizationSettings>) };
  } catch {
    cachedSettings = { ...DEFAULTS };
  }
  return cachedSettings;
}

export function saveCustomizationSettings(patch: Partial<CustomizationSettings>): CustomizationSettings {
  const next = { ...readCustomizationSettings(), ...patch };
  cachedSettings = next;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* storage quota/private mode */ }
    saveTimer = undefined;
  }, 250);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

export function useCustomizationSettings(): [CustomizationSettings, (patch: Partial<CustomizationSettings>) => void] {
  const [settings, setSettings] = useState<CustomizationSettings>(readCustomizationSettings);
  useEffect(() => {
    const sync = () => setSettings(readCustomizationSettings());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);
  return [settings, (patch) => setSettings(saveCustomizationSettings(patch))];
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const sync = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

const LOCK_IMAGES = [
  `${import.meta.env.BASE_URL}custom_seasonal/diamondlock_kindpng_4497640.png`,
  `${import.meta.env.BASE_URL}custom_seasonal/worldlock_PngItem_1106058.png`,
];

export function CustomAtmosphere() {
  const [settings] = useCustomizationSettings();
  const compact = useMediaQuery("(max-width: 767px)");
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pageVisible = usePageVisible();
  const particleCount = reduced ? 4 : compact ? 6 : 12;
  const particles = useMemo(() => Array.from({ length: particleCount }, (_, index) => ({
    id: index,
    left: `${(index * 37 + 11) % 100}%`,
    size: 18 + ((index * 13) % 18),
    delay: `${-((index * 2.7) % 16)}s`,
    duration: `${10 + ((index * 1.7) % 8)}s`,
    image: LOCK_IMAGES[index % LOCK_IMAGES.length],
  })), [particleCount]);

  return (
    <>
      {settings.backgroundDataUrl && settings.backgroundEnabled && (
        <div
          className="custom-background-layer"
          aria-hidden="true"
          style={{
            backgroundImage: `url(${settings.backgroundDataUrl})`,
            opacity: (settings.backgroundOpacity / 100) * (compact ? 0.82 : 1),
            "--custom-bg-blur": `${settings.backgroundBlur}px`,
          } as CSSProperties}
        />
      )}
      {settings.locksEnabled && (
        <div className={`custom-locks-layer${pageVisible ? "" : " is-paused"}`} aria-hidden="true">
          {particles.map((particle) => (
            <img
              key={particle.id}
              src={settings.seasonalItemDataUrl ?? particle.image}
              alt=""
              className="custom-lock-particle"
              style={{ left: particle.left, width: settings.seasonalItemDataUrl ? settings.seasonalItemSize : particle.size, height: settings.seasonalItemDataUrl ? settings.seasonalItemSize : particle.size, animationDelay: particle.delay, animationDuration: `${(Number.parseFloat(particle.duration) / settings.locksFrequency).toFixed(2)}s` }}
            />
          ))}
        </div>
      )}
    </>
  );
}

async function shrinkSeasonalImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/webp", 0.82);
}

export function SeasonalItemUpload({ onError }: { onError: (message: string) => void }) {
  const [settings, setSettings] = useCustomizationSettings();
  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { onError("Choose an image file."); return; }
    if (file.size > 8 * 1024 * 1024) { onError("Image must be 8 MB or smaller."); return; }
    try { setSettings({ seasonalItemDataUrl: await shrinkSeasonalImage(file) }); }
    catch { onError("Could not process this image."); }
  };
  return <div className="mt-3 space-y-2 rounded-lg border border-[var(--inner-border)] bg-[var(--glass-bg)] p-3">
    <div className="flex flex-wrap items-center gap-2"><label className="inline-flex cursor-pointer items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90">Upload custom item<input type="file" accept="image/*" className="sr-only" onChange={(event) => void handleFile(event)} /></label>{settings.seasonalItemDataUrl && <button type="button" className="text-xs text-[var(--red)] hover:underline" onClick={() => setSettings({ seasonalItemDataUrl: null })}>Use locks</button>}</div>
    <p className="text-[10px] leading-4 text-[var(--text-3)]">Image is resized to max 256px for smooth animation. Recommended rendered size: 24–40px.</p>
    {settings.seasonalItemDataUrl && <label className="block text-xs text-[var(--text-2)]">Item size <span className="float-right font-mono text-[var(--text-3)]">{settings.seasonalItemSize}px</span><input type="range" min="16" max="56" step="2" value={settings.seasonalItemSize} onChange={(event) => setSettings({ seasonalItemSize: Number(event.target.value) })} className="mt-1 w-full accent-[var(--accent)]" /></label>}
  </div>;
}

export function BackgroundUpload({ onError }: { onError: (message: string) => void }) {
  const [settings, setSettings] = useCustomizationSettings();
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { onError("Choose an image file."); return; }
    if (file.size > 8 * 1024 * 1024) { onError("Image must be 8 MB or smaller."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setSettings({ backgroundDataUrl: reader.result, backgroundEnabled: true });
    };
    reader.onerror = () => onError("Could not read this image.");
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90">
          Upload background
          <input type="file" accept="image/*" className="sr-only" onChange={handleFile} />
        </label>
        {settings.backgroundDataUrl && <button type="button" className="text-xs text-[var(--red)] hover:underline" onClick={() => setSettings({ backgroundDataUrl: null, backgroundEnabled: false })}>Remove</button>}
      </div>
      {settings.backgroundDataUrl && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-[var(--text-2)]">Visibility <input type="range" min="8" max="70" value={settings.backgroundOpacity} onChange={(event) => setSettings({ backgroundOpacity: Number(event.target.value) })} className="mt-1 w-full accent-[var(--accent)]" /></label>
          <label className="text-xs text-[var(--text-2)]">Blur <input type="range" min="0" max="18" value={settings.backgroundBlur} onChange={(event) => setSettings({ backgroundBlur: Number(event.target.value) })} className="mt-1 w-full accent-[var(--accent)]" /></label>
          <label className="col-span-full flex items-center gap-2 text-xs text-[var(--text-2)]"><input type="checkbox" checked={settings.backgroundEnabled} onChange={(event) => setSettings({ backgroundEnabled: event.target.checked })} /> Show custom background behind frosted glass</label>
        </div>
      )}
    </div>
  );
}
