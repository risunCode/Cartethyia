/** Motion tokens — REQ-24. Only transform/opacity animate. */

export const duration = { instant: 0.1, fast: 0.18, base: 0.25, slow: 0.4 };

export const easeOut = [0.2, 0.8, 0.2, 1] as const;

export const springPress = { type: "spring", stiffness: 500, damping: 32 } as const;

export const fadeSlide = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: duration.base, ease: easeOut },
};

/**
 * Route-level crossfade — mirrors macOS pane switching (System Settings):
 * a quick fade+scale dissolve where the outgoing view leaves faster than the
 * incoming one arrives. Only opacity/scale animate (REQ-24).
 */
export const pageTransition = {
  initial: { opacity: 0, scale: 0.985 },
  animate: { opacity: 1, scale: 1, transition: { duration: duration.base, ease: easeOut } },
  exit: { opacity: 0, scale: 1.01, transition: { duration: duration.fast, ease: easeOut } },
};

export const staggerItem = (index: number) => ({
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: duration.fast, ease: easeOut, delay: Math.min(index, 12) * 0.03 },
});

/**
 * CSS-only stagger — zero JS overhead, zero framer-motion visualElement
 * instances, no memory leak on navigation. Use `staggerClass(i)` on a plain
 * `<div>` instead of `motion.div + staggerItem(i)` for list items.
 */
export function staggerClass(index: number): { className: string; style: React.CSSProperties } {
  return {
    className: "stagger-item",
    style: { animationDelay: `${Math.min(index, 12) * 30}ms` },
  };
}
