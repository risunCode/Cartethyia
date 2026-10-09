/**
 * Cosmetic settings for the console shell.
 *
 * The numbers live in `localStorage` so they can be read synchronously at boot,
 * before React renders, and applied to `<html>` without a flash. The media
 * itself is a blob and lives in IndexedDB (`media.ts`); only its presence is
 * recorded here, so a quota error can never take the settings down with it.
 *
 * Every write also mirrors the values onto `documentElement.dataset`, which is
 * what the CSS in `console.css` keys off. The page, the shell, and a second
 * tab stay in agreement through one `CustomEvent`.
 */

import { useEffect, useState } from "react";

/** How a surface blurs whatever sits behind it. */
export type BlurStyle = "none" | "frosted" | "vibrancy" | "heavy";

export const BLUR_STYLES: readonly BlurStyle[] = ["none", "frosted", "vibrancy", "heavy"];

/** Which shell surface a blur style applies to. */
export type BlurTarget = "cards" | "tiles" | "chrome";

export interface CustomizationSettings {
  /** A background blob is stored. The layer renders only when this is true. */
  readonly backgroundSet: boolean;
  readonly backgroundEnabled: boolean;
  /** 0–100. How strongly the background shows through the page. */
  readonly backgroundOpacity: number;
  /** 100–180. Cover zoom; 100 fills the viewport exactly. */
  readonly backgroundScale: number;
  /** -100–100. Horizontal anchor; 0 is centered. */
  readonly backgroundX: number;
  /** -100–100. Vertical anchor; 0 is centered. */
  readonly backgroundY: number;
  readonly blurCards: BlurStyle;
  readonly blurTiles: BlurStyle;
  readonly blurChrome: BlurStyle;
}

export const CUSTOMIZATION_DEFAULTS: CustomizationSettings = {
  backgroundSet: false,
  backgroundEnabled: false,
  backgroundOpacity: 40,
  backgroundScale: 100,
  backgroundX: 0,
  backgroundY: 0,
  // The console already ships frosted; a fresh profile keeps that look.
  blurCards: "frosted",
  blurTiles: "frosted",
  blurChrome: "frosted",
};

const STORAGE_KEY = "cartethyia.customization";
const CHANGE_EVENT = "cartethyia-customization-change";

const BLUR_TARGETS: readonly BlurTarget[] = ["cards", "tiles", "chrome"];

function isBlurStyle(value: unknown): value is BlurStyle {
  return typeof value === "string" && (BLUR_STYLES as readonly string[]).includes(value);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** Coerces whatever was persisted into a complete, in-range settings object. */
export function normalizeCustomization(raw: unknown): CustomizationSettings {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Partial<CustomizationSettings>)
    : {};
  return {
    backgroundSet: source.backgroundSet === true,
    backgroundEnabled: source.backgroundEnabled === true,
    backgroundOpacity: clamp(source.backgroundOpacity, 0, 100, CUSTOMIZATION_DEFAULTS.backgroundOpacity),
    backgroundScale: clamp(source.backgroundScale, 100, 180, CUSTOMIZATION_DEFAULTS.backgroundScale),
    backgroundX: clamp(source.backgroundX, -100, 100, CUSTOMIZATION_DEFAULTS.backgroundX),
    backgroundY: clamp(source.backgroundY, -100, 100, CUSTOMIZATION_DEFAULTS.backgroundY),
    blurCards: isBlurStyle(source.blurCards) ? source.blurCards : CUSTOMIZATION_DEFAULTS.blurCards,
    blurTiles: isBlurStyle(source.blurTiles) ? source.blurTiles : CUSTOMIZATION_DEFAULTS.blurTiles,
    blurChrome: isBlurStyle(source.blurChrome) ? source.blurChrome : CUSTOMIZATION_DEFAULTS.blurChrome,
  };
}

let cached: CustomizationSettings | null = null;

export function readCustomizationSettings(): CustomizationSettings {
  if (cached) return cached;
  if (typeof window === "undefined") return CUSTOMIZATION_DEFAULTS;
  try {
    cached = normalizeCustomization(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    cached = { ...CUSTOMIZATION_DEFAULTS };
  }
  return cached;
}

/**
 * Publishes the current settings as `data-blur-*` and `data-bg-*` on `<html>`.
 * CSS consumes these directly, so a change repaints without a component
 * re-render anywhere except the controls that show the numbers.
 */
export function applyCustomization(settings: CustomizationSettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.blurCards = settings.blurCards;
  root.dataset.blurTiles = settings.blurTiles;
  root.dataset.blurChrome = settings.blurChrome;
  root.dataset.bgActive = settings.backgroundSet && settings.backgroundEnabled ? "true" : "false";
  root.style.setProperty("--bg-opacity", (settings.backgroundOpacity / 100).toFixed(2));
  root.style.setProperty("--bg-scale", (settings.backgroundScale / 100).toFixed(2));
  root.style.setProperty("--bg-x", `${settings.backgroundX}%`);
  root.style.setProperty("--bg-y", `${settings.backgroundY}%`);
}

function persist(settings: CustomizationSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full quota. The in-memory copy still drives this session.
  }
}

export function saveCustomizationSettings(patch: Partial<CustomizationSettings>): CustomizationSettings {
  const next = normalizeCustomization({ ...readCustomizationSettings(), ...patch });
  cached = next;
  if (typeof window !== "undefined") {
    persist(next);
    applyCustomization(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }
  return next;
}

/** Drops the cached copy so the next read comes from storage. Tests use this. */
export function resetCustomizationCache(): void {
  cached = null;
}

export function useCustomizationSettings(): readonly [
  CustomizationSettings,
  (patch: Partial<CustomizationSettings>) => void,
] {
  const [settings, setSettings] = useState<CustomizationSettings>(readCustomizationSettings);
  useEffect(() => {
    const sync = () => setSettings(readCustomizationSettings());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return [settings, (patch) => setSettings(saveCustomizationSettings(patch))] as const;
}

export function blurStyleOf(settings: CustomizationSettings, target: BlurTarget): BlurStyle {
  if (target === "cards") return settings.blurCards;
  if (target === "tiles") return settings.blurTiles;
  if (target === "chrome") return settings.blurChrome;
  return settings.blurCards;
}

export function blurPatch(target: BlurTarget, style: BlurStyle): Partial<CustomizationSettings> {
  if (target === "cards") return { blurCards: style };
  if (target === "tiles") return { blurTiles: style };
  if (target === "chrome") return { blurChrome: style };
  return { blurCards: style };
}

export const BLUR_TARGET_ORDER: readonly BlurTarget[] = BLUR_TARGETS;
