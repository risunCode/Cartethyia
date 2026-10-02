/**
 * Rendering helpers for dashboard suites.
 *
 * Two modes, chosen by what the suite needs to prove:
 *
 * - `renderMarkup` renders to a string. Fastest, and the right tool for a
 *   component whose contract is what it *emits* — labels, aria attributes,
 *   disabled state, which branch of a conditional was taken. It cannot observe
 *   a click.
 * - `mount` renders into a live DOM and returns queries plus an `act`-style
 *   `flush`. Use it when the assertion is about behaviour after interaction
 *   (a filter narrowing a list, a toggle hiding a column, a dialog opening).
 *
 * Both wrap the tree in the providers every dashboard route assumes exist — a
 * `QueryClientProvider` with retries off and a `MemoryRouter` — so a suite
 * never has to remember them and a missing provider can never masquerade as a
 * component bug. Query data is seeded through `seedQuery`, which writes into
 * the same cache the component reads, so no fetch is needed to reach a
 * populated state.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { registerDom, resetDom } from "./dom";

/** A query client configured for tests: no retries, no background refetch. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // `staleTime: Infinity` keeps a seeded entry from being refetched the
        // moment a component mounts, and `refetchOnMount: false` covers the
        // case a component overrides the stale time itself.
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
      },
      mutations: { retry: false },
    },
  });
}

export interface RenderOptions {
  /** Router entry; a parameterized route needs the real path. */
  readonly path?: string;
  /** Pre-populated query cache, keyed by `queryKey`. */
  readonly seed?: readonly { readonly key: readonly unknown[]; readonly data: unknown }[];
  readonly queryClient?: QueryClient;
}

function buildTree(node: ReactNode, options: RenderOptions, client: QueryClient): ReactNode {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      MemoryRouter,
      { initialEntries: [options.path ?? "/"] },
      node as Parameters<typeof createElement>[1] extends never ? never : ReactNode,
    ),
  );
}

function applySeed(client: QueryClient, options: RenderOptions): void {
  for (const entry of options.seed ?? []) {
    client.setQueryData([...entry.key], entry.data);
  }
}

/**
 * Renders a component to static markup with the standard providers applied.
 *
 * Deterministic and synchronous, which is what makes it the right default: a
 * suite that renders to a string cannot accidentally depend on an effect
 * having run.
 */
export function renderMarkup(node: ReactNode, options: RenderOptions = {}): string {
  const client = options.queryClient ?? createTestQueryClient();
  applySeed(client, options);
  return renderToStaticMarkup(buildTree(node, options, client) as Parameters<typeof renderToStaticMarkup>[0]);
}

/** A mounted tree, with the handles a behaviour test needs. */
export interface Mounted {
  readonly container: HTMLElement;
  readonly queryClient: QueryClient;
  /** Lets pending effects, promises, and state updates settle. */
  flush(): Promise<void>;
  /** Runs `body` inside React's act(), flushing updates it triggers. */
  act<T>(body: () => T | Promise<T>): Promise<T>;
  unmount(): void;
  /** Queries within the mounted container only. */
  text(selector?: string): string;
  find(selector: string): Element | null;
  findAll(selector: string): Element[];
  /** Dispatches a real click on the first match; throws when nothing matches. */
  click(selector: string): Promise<void>;
}

/**
 * Query root for a mounted tree.
 *
 * `container` alone is not enough: a dialog, drawer, or popover renders through
 * `createPortal` into `document.body`, so a query scoped to the container would
 * never find it and a suite would conclude the component did not render. The
 * container is still the right root for everything else, because it isolates
 * one test's tree from a previous test's leftovers — so the helper looks in the
 * container first and only falls back to the document.
 */
function queryIn(container: HTMLElement, selector: string): Element | null {
  return container.querySelector(selector) ?? document.querySelector(selector);
}

function queryAllIn(container: HTMLElement, selector: string): Element[] {
  const scoped = [...container.querySelectorAll(selector)];
  return scoped.length > 0 ? scoped : [...document.querySelectorAll(selector)];
}

/**
 * Mounts a component into a live DOM.
 *
 * The returned `flush` awaits a macrotask and then drains React's work queue,
 * which is what makes an assertion after an interaction reliable: without it a
 * suite is asserting against a tree React has not committed yet.
 */
export async function mount(node: ReactNode, options: RenderOptions = {}): Promise<Mounted> {
  registerDom();
  resetDom();
  const client = options.queryClient ?? createTestQueryClient();
  applySeed(client, options);
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      buildTree(node, options, client) as Parameters<Root["render"]>[0],
    );
  });
  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return {
    container,
    queryClient: client,
    flush,
    async act<T>(body: () => T | Promise<T>): Promise<T> {
      let result!: T;
      await act(async () => {
        result = await body();
      });
      return result;
    },
    unmount() {
      const mounted = root;
      root = undefined;
      if (mounted) {
        act(() => {
          mounted.unmount();
        });
      }
      container.remove();
    },
    text(selector) {
      return selector
        ? (queryIn(container, selector)?.textContent ?? "")
        : container.textContent ?? "";
    },
    find(selector) {
      return queryIn(container, selector);
    },
    findAll(selector) {
      return queryAllIn(container, selector);
    },
    async click(selector) {
      const target = queryIn(container, selector);
      if (!target) throw new Error(`click target not found: ${selector}`);
      await act(async () => {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
  };
}

/**
 * Builds a `fetch` stub that answers from a routing table.
 *
 * A dashboard suite that renders a route with a query needs `fetch` to answer,
 * and asserting against a real gateway would make the suite depend on the
 * backend's state. This stub matches on a path substring so a suite can state
 * only the endpoints it cares about; an unmatched request rejects loudly rather
 * than returning `undefined`, because a silently empty response is how a
 * fixture gap turns into a false pass.
 */
export function stubFetch(
  routes: readonly { readonly match: string; readonly json: unknown; readonly status?: number }[],
): { readonly calls: readonly string[]; restore(): void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? "GET"} ${url}`);
    for (const route of routes) {
      if (!url.includes(route.match)) continue;
      if (init?.method !== undefined && route.match.includes(init.method) === false) {
        // A method-qualified match (`"POST /providers"`) only answers that verb.
        if (route.match.startsWith(`${init.method} `)) {
          return jsonResponse(route.json, route.status ?? 200);
        }
        continue;
      }
      return jsonResponse(route.json, route.status ?? 200);
    }
    throw new Error(`stubFetch: no route matched ${url}`);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Builds a JSON `Response` for a fetch stub. */
export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
