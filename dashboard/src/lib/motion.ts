import { useEffect, useState } from "react";

export type MotionProfile = "desktop" | "mobile" | "reduced" | "max";

/** Event dispatched when the motion profile changes. */
export const MOTION_OVERRIDE_EVENT = "cartethyia:motion-override";

export interface MotionEnvironment {
  readonly reducedMotion: boolean;
  readonly mobile: boolean;
  readonly saveData: boolean;
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
}

/**
 * Resolves a concrete motion profile from the device environment.
 * Reduced motion always wins; constrained devices use the smallest profile.
 */
export function resolveMotionProfile(environment: MotionEnvironment): MotionProfile {
  if (environment.reducedMotion) return "reduced";
  if (
    environment.mobile ||
    environment.saveData ||
    (environment.deviceMemory !== undefined && environment.deviceMemory <= 2) ||
    (environment.hardwareConcurrency !== undefined && environment.hardwareConcurrency <= 2)
  ) {
    return "mobile";
  }
  if ((environment.deviceMemory ?? 4) >= 16 && (environment.hardwareConcurrency ?? 4) >= 8) return "max";
  return "desktop";
}

function writeMotionProfile(profile: MotionProfile): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.motionProfile = profile;
  document.documentElement.dataset.motionReduced = String(profile === "reduced");
}

export function detectMotionProfile(): MotionProfile {
  if (typeof window === "undefined" || typeof navigator === "undefined" || typeof window.matchMedia !== "function") {
    return resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false });
  }
  const extendedNavigator = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  return resolveMotionProfile({
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    mobile: window.matchMedia("(max-width: 767px), (pointer: coarse)").matches,
    saveData: extendedNavigator.connection?.saveData === true,
    deviceMemory: extendedNavigator.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
}

/** Applies the detected profile before the first React paint. */
export function initializeMotionProfile(): void {
  writeMotionProfile(detectMotionProfile());
}

/** Keeps the root profile attribute synchronized with device preference changes. */
export function useMotionProfile(): MotionProfile {
  const [profile, setProfile] = useState<MotionProfile>(() => detectMotionProfile());

  useEffect(() => {
    const mediaQueries = typeof window.matchMedia === "function"
      ? [
          window.matchMedia("(max-width: 767px)"),
          window.matchMedia("(pointer: coarse)"),
          window.matchMedia("(prefers-reduced-motion: reduce)"),
        ]
      : [];
    const sync = () => {
      const next = detectMotionProfile();
      setProfile(next);
      writeMotionProfile(next);
    };
    sync();
    for (const media of mediaQueries) media.addEventListener("change", sync);
    window.addEventListener(MOTION_OVERRIDE_EVENT, sync);
    return () => {
      for (const media of mediaQueries) media.removeEventListener("change", sync);
      window.removeEventListener(MOTION_OVERRIDE_EVENT, sync);
    };
  }, []);

  return profile;
}

/** Returns the CSS exit fallback duration for presence-based components. */
export function getExitDuration(profile: MotionProfile): number {
  if (profile === "reduced") return 0;
  if (profile === "mobile") return 120;
  if (profile === "max") return 240;
  return 180;
}

/**
 * CSS-only stagger — no animation runtime or per-item visual element.
 * Consumers may override the class while retaining the delay style.
 */
export function staggerClass(index: number): { className: string; style: React.CSSProperties } {
  return {
    className: "stagger-item",
    style: { animationDelay: `${Math.min(index, 6) * 16}ms` },
  };
}
