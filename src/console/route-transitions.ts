/**
 * In-memory bounded RouteTransitionStore implementation.
 *
 * Extracted from `services.ts` so the implementation owns its own file while
 * the interface and view types live in `views.ts`.
 */

import type { RouteScope, RouteSwitch } from "../domain/contracts";
import { runtimeMemoryLimits } from "../traffic/limits";
import type { RouteTransitionStore } from "./views";

/**
 * In-memory RouteTransitionStore bounded by `runtimeMemoryLimits`:
 * `maxRouteTransitionRoutes` caps the total number of tracked route ids
 * across ALL scopes, and `maxRouteTransitionsPerRoute` caps the ring kept
 * per route id. When the global cap is reached, the oldest-inserted route
 * is evicted in O(1) via V8 Map insertion-order semantics. Per-scope rings
 * stay separated and empty scope maps are dropped so no unbounded route-id
 * map remains.
 */
export class MemoryRouteTransitionStore implements RouteTransitionStore {
  private readonly rings = new Map<RouteScope, Map<string, RouteSwitch[]>>();
  private readonly limits: Pick<typeof runtimeMemoryLimits, "maxRouteTransitionRoutes" | "maxRouteTransitionsPerRoute">;

  constructor(limits: Pick<typeof runtimeMemoryLimits, "maxRouteTransitionRoutes" | "maxRouteTransitionsPerRoute"> = runtimeMemoryLimits) {
    this.limits = limits;
  }
  private routeCount = 0;

  private ring(scope: RouteScope): Map<string, RouteSwitch[]> {
    let routes = this.rings.get(scope);
    if (routes === undefined) {
      routes = new Map<string, RouteSwitch[]>();
      this.rings.set(scope, routes);
    }
    return routes;
  }

  /**
   * Evicts the globally oldest-inserted route — O(1) via V8 Map insertion
   * order. Walks scope rings (outer map) then route ids (inner map) to find
   * the first entry, which is the oldest-inserted key. In practice the outer
   * map has ≤ 3 scopes, so this is effectively constant-time.
   */
  private evictOldest(): void {
    for (const [scope, routes] of this.rings) {
      const oldest = routes.keys().next();
      if (!oldest.done) {
        routes.delete(oldest.value as string);
        if (routes.size === 0) this.rings.delete(scope);
        this.routeCount -= 1;
        return;
      }
    }
  }

  async record(scope: RouteScope, routeId: string, event: RouteSwitch): Promise<void> {
    const routes = this.ring(scope);
    let events = routes.get(routeId);
    const isNew = events === undefined;
    if (isNew && this.routeCount >= this.limits.maxRouteTransitionRoutes) {
      this.evictOldest();
      // re-fetch ring — eviction above may have deleted this scope's map
      const ringMap = this.ring(scope);
      events = ringMap.get(routeId) ?? undefined;
    }
    if (events === undefined) {
      events = [];
      this.ring(scope).set(routeId, events);
    }
    events.push(event);
    if (events.length > this.limits.maxRouteTransitionsPerRoute) {
      events.splice(0, events.length - this.limits.maxRouteTransitionsPerRoute);
    }
    if (isNew) this.routeCount += 1;
  }

  async latest(scope: RouteScope, routeId: string): Promise<RouteSwitch | null> {
    const events = this.rings.get(scope)?.get(routeId);
    return events === undefined || events.length === 0 ? null : (events[events.length - 1] ?? null);
  }
}
