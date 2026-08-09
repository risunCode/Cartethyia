import type { RouteHealth, RouteScope, RouteSwitch } from "../../application/contracts";

// ---------------------------------------------------------------------------
// Route switch metadata
// ---------------------------------------------------------------------------

/**
 * Bounded log of account/proxy switch events so console diagnostics can show
 * the failed route and the replacement route as separate values. The data
 * plane records switches here through the same interface; the log is capped
 * to a fixed ring so it can never grow without bound.
 */
export interface RouteTransitionStore {
  record(scope: RouteScope, routeId: string, event: RouteSwitch): Promise<void>;
  latest(scope: RouteScope, routeId: string): Promise<RouteSwitch | null>;
}

/**
 * Failed/replacement route view for one route. `failedRoute` keeps the
 * failed route's identity and last bounded error; `replacementRoute` names
 * the separate current selection. Never overwrites the failure with a
 * generic healthy state.
 */
export interface RouteTransitionView {
  readonly failedRoute: { readonly id: string; readonly scope: RouteScope; readonly health: RouteHealth | null } | null;
  readonly replacementRoute: { readonly id: string; readonly scope: RouteScope } | null;
  readonly switchEvent: RouteSwitch | null;
}

export async function loadRouteTransition(
  scope: RouteScope,
  routeId: string,
  _health: RouteHealth | null,
  store: RouteTransitionStore,
): Promise<RouteTransitionView> {
  const event = await store.latest(scope, routeId);
  if (event === null) return { failedRoute: null, replacementRoute: null, switchEvent: null };
  return {
    failedRoute:
      event.previousRouteId !== null && event.previousRouteId !== routeId
        ? { id: event.previousRouteId, scope, health: null }
        : null,
    replacementRoute:
      event.replacementRouteId !== null && event.replacementRouteId !== routeId
        ? { id: event.replacementRouteId, scope }
        : null,
    switchEvent: event,
  };
}

