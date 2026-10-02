/**
 * DOM registration for dashboard suites that mount real components.
 *
 * Two kinds of suite exist in `dashboard/test`:
 *
 * - **Pure** suites (`format.ts`, `http-status.ts`, query policy) test a
 *   function and need nothing but `bun:test`. They import this module only for
 *   the shared fetch stub.
 * - **Rendered** suites mount a React component and assert on the result. They
 *   need a DOM, and Bun does not ship one.
 *
 * `happy-dom` is registered lazily, so a pure suite never pays for building a
 * document. Registration is idempotent: several files can share one worker
 * process, and replacing `document` under a component that already mounted
 * would break the assertion rather than the setup.
 */
import { Window } from "happy-dom";

let registered = false;

/**
 * Installs a DOM on `globalThis` if one is not already present.
 *
 * Call at the top of a suite that renders. Bun evaluates a test file's imports
 * before any hook runs, so this must be a plain call rather than something
 * deferred into `beforeAll` — a component module that reads `document` at
 * import time would otherwise see `undefined`.
 */
export function registerDom(): void {
  if (registered || typeof globalThis.document !== "undefined") {
    registered = true;
    return;
  }
  const window = new Window({ url: "http://localhost/" });
  // React 19 refuses to run `act()` unless the environment declares itself a
  // test environment. Without this the mount helper still renders, but React
  // logs a warning and skips the commit-flush semantics that make an assertion
  // after an interaction reliable.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    history: window.history,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    IntersectionObserver: window.IntersectionObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    matchMedia: (query: string) => createMediaQueryList(query),
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
  };
  for (const [key, value] of Object.entries(globals)) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
  registered = true;
}

/**
 * Minimal `matchMedia` stand-in.
 *
 * happy-dom implements `window.matchMedia`, but React components in this
 * dashboard subscribe to it for reduced-motion and theme detection, and the
 * subscription must survive a re-render. This wrapper gives each query a stable
 * listener list so a component can add and remove its listener without the
 * stand-in throwing on an unimplemented method.
 */
function createMediaQueryList(query: string): MediaQueryList {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const list = {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  };
  return list as unknown as MediaQueryList;
}

/** Removes every child of `document.body` between tests. */
export function resetDom(): void {
  if (typeof document === "undefined") return;
  document.body.innerHTML = "";
  document.head.innerHTML = "";
}
