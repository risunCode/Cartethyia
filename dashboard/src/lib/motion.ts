import { useEffect, useState } from "react";

/** Motion tokens — only transform/opacity animate. */

export const duration = { instant: 0.08, fast: 0.12, base: 0.16, slow: 0.24 };

export const easeOut = [0.2, 0.8, 0.2, 1] as const;

export type MotionProfile = "desktop" | "mobile" | "reduced" | "max";

/** Event dispatched when the motion profile changes (e.g. user toggles
 *  prefers-reduced-motion in OS settings, or rotates device). */
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
 * Fully automatic — no manual override:
 * - `prefers-reduced-motion: reduce` → "reduced" (zero motion, always wins)
 * - Mobile / coarse pointer / ≤2GB RAM / ≤2 cores / save-data → "mobile" (fast CSS)
 * - Capable desktop (fine pointer, ≥4GB RAM, ≥4 cores) → "desktop" (balanced)
 * - High-end (≥16GB RAM, ≥8 cores, fine pointer) → "max" (rich transitions)
 */
export function resolveMotionProfile(environment: MotionEnvironment): MotionProfile {
  if (environment.reducedMotion) return "reduced";
  if (environment.mobile || environment.saveData || (environment.deviceMemory !== undefined && environment.deviceMemory <= 2) || (environment.hardwareConcurrency !== undefined && environment.hardwareConcurrency <= 2)) {
    return "mobile";
  }
  // High-end desktop: rich transitions only when there's plenty of headroom.
  if ((environment.deviceMemory ?? 4) >= 16 && (environment.hardwareConcurrency ?? 4) >= 8) {
    return "max";
  }
  return "desktop";
}

export function detectMotionProfile(): MotionProfile {
  if (typeof window === "undefined" || typeof navigator === "undefined" || typeof window.matchMedia !== "function") {
    return resolveMotionProfile({ reducedMotion: false, mobile: false, saveData: false });
  }
  const extendedNavigator = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  return resolveMotionProfile({
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    mobile: window.matchMedia("(max-width: 767px), (pointer: coarse)").matches,
    saveData: extendedNavigator.connection?.saveData === true,
    deviceMemory: extendedNavigator.deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
  });
}

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
      document.documentElement.dataset.motionProfile = next;
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

export function getDialogMotion(profile: MotionProfile) {
  if (profile === "reduced") {
    return {
      overlay: { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 }, transition: { duration: 0 } },
      panel: { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 }, transition: { duration: 0 } },
    };
  }
  if (profile === "mobile") {
    return {
      overlay: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: duration.instant, ease: easeOut } },
      panel: { initial: { opacity: 0, scale: 0.985, y: 4 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.99, y: 3 }, transition: { duration: duration.instant, ease: easeOut } },
    };
  }
  if (profile === "max") {
    return {
      overlay: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: duration.base, ease: easeOut } },
      panel: { initial: { opacity: 0, scale: 0.94, y: 12 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.96, y: 8 }, transition: { duration: duration.slow, ease: easeOut } },
    };
  }
  return {
    overlay: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: duration.fast, ease: easeOut } },
    panel: { initial: { opacity: 0, scale: 0.96, y: 8 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.97, y: 6 }, transition: { duration: duration.base, ease: easeOut } },
  };
}

export function getDrawerMotion(profile: MotionProfile) {
  if (profile === "reduced") {
    return {
      overlay: { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 }, transition: { duration: 0 } },
      panel: { initial: { x: 0 }, animate: { x: 0 }, exit: { x: 0 }, transition: { duration: 0 } },
    };
  }
  let transition = { duration: duration.base, ease: easeOut };
  if (profile === "max") transition = { duration: duration.slow, ease: easeOut };
  if (profile === "mobile") transition = { duration: duration.instant, ease: easeOut };
  return {
    overlay: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition },
    panel: { initial: { x: "105%" }, animate: { x: 0 }, exit: { x: "105%" }, transition },
  };
}

export function getPopoverMotion(profile: MotionProfile) {
  if (profile === "reduced") {
    return {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: { duration: 0 },
    };
  }
  let transition = { duration: duration.base, ease: easeOut };
  if (profile === "mobile") transition = { duration: duration.instant, ease: easeOut };
  return {
    initial: { opacity: 0, y: -6, scale: profile === "max" ? 0.94 : 0.97 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -4, scale: profile === "max" ? 0.96 : 0.98 },
    transition,
  };
}

export interface PageTransition {
  readonly initial: { opacity: number; y?: number; scale?: number };
  readonly animate: { opacity: number; y?: number; scale?: number };
  readonly exit: { opacity: number; y?: number; scale?: number; transition: { duration: number; ease: typeof easeOut } };
  readonly transition: { duration: number; ease: typeof easeOut };
}

const desktopPageTransition: PageTransition = {
  initial: { opacity: 0, scale: 0.985 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 1.01, transition: { duration: duration.fast, ease: easeOut } },
  transition: { duration: duration.base, ease: easeOut },
};

const mobilePageTransition: PageTransition = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -2, transition: { duration: duration.instant, ease: easeOut } },
  transition: { duration: duration.fast, ease: easeOut },
};

const reducedPageTransition: PageTransition = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 1, transition: { duration: 0, ease: easeOut } },
  transition: { duration: 0, ease: easeOut },
};

const maxPageTransition: PageTransition = {
  initial: { opacity: 0, y: 12, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -5, scale: 0.995, transition: { duration: duration.base, ease: easeOut } },
  transition: { duration: 0.34, ease: easeOut },
};

/**
 * Route-level transition profiles: richer pane switching on desktop, a
 * shorter transform-only handoff on mobile, and no movement for reduced motion.
 */
export function getPageTransition(profile: MotionProfile): PageTransition {
  if (profile === "reduced") return reducedPageTransition;
  if (profile === "max") return maxPageTransition;
  if (profile === "mobile") return mobilePageTransition;
  return desktopPageTransition;
}

/**
 * CSS-only stagger — zero JS overhead, zero framer-motion visualElement
 * instances, no memory leak on navigation. Use `staggerClass(i)` on a plain
 * `<div>` instead of `motion.div + staggerItem(i)` for list items.
 */
export function staggerClass(index: number): { className: string; style: React.CSSProperties } {
  return {
    className: "stagger-item",
    style: { animationDelay: `${Math.min(index, 6) * 16}ms` },
  };
}
