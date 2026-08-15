/**
 * Shared ~1s time tick for components that need to re-render periodically to
 * refresh relative timestamps (TimeAgo). Instead of each instance running its
 * own setInterval — one timer per row in a high-traffic dashboard — all
 * subscribers share a single requestAnimationFrame loop that fires roughly
 * once per second and notifies everyone together.
 *
 * Solid subscribers attach to the shared store and re-render in lockstep when
 * the tick advances.
 */

let tickCount = 0;
const subscribers = new Set<() => void>();
let rafId: number | null = null;
let lastFire = 0;

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

/** rAF loop: advances tickCount once ~1000ms has elapsed, then re-queues. */
const loop = (now: number): void => {
  if (now - lastFire >= 1000) {
    tickCount += 1;
    lastFire = now;
    notify();
  }
  rafId = requestAnimationFrame(loop);
};

function start(): void {
  if (rafId !== null) return;
  lastFire = performance.now();
  rafId = requestAnimationFrame(loop);
}

function stop(): void {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}

/** Subscribes to the shared clock, starting it lazily and stopping on last unsubscribe. */
export function subscribeTimeTick(callback: () => void): () => void {
  subscribers.add(callback);
  if (subscribers.size === 1) start();
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) stop();
  };
}

/** Returns the current shared tick counter. */
export function getTimeTick(): number {
  return tickCount;
}
