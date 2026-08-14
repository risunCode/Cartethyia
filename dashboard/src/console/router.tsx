import { createBrowserRouter, Navigate, redirect } from "react-router-dom";
import type { ComponentType } from "react";
import { AppShell } from "./layout";
import { LoginPage } from "../features/login/page";
import { RouteError } from "./route-error";
import { safeConsoleNextPath } from "../routes";

export async function guardLoader({ request }: { request: Request }): Promise<Response | null> {
  const res = await fetch("/console/api/v2/admin/auth/session", { credentials: "same-origin" });
  if (res.status === 401) {
    const next = safeConsoleNextPath(new URL(request.url).pathname.replace(/^\/console/, "") || "/overview");
    return redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return null;
}

/**
 * Chunk filenames carry a content hash, so a tab left open across a rebuild
 * asks for a chunk the server no longer has. That surfaces as "Failed to fetch
 * dynamically imported module". Reloading picks up the fresh entry point.
 *
 * The guard is a timestamp, not a one-shot flag: a flag that latches for the
 * whole session would block every later recovery, leaving the user to refresh
 * by hand. Only a reload within the cooldown suppresses another one, which is
 * enough to stop a genuinely broken chunk from looping.
 */
const RELOAD_STAMP = "cartethyia:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 10_000;

function reloadedRecently(): boolean {
  const raw = sessionStorage.getItem(RELOAD_STAMP);
  if (!raw) return false;
  const at = Number(raw);
  return Number.isFinite(at) && Date.now() - at < RELOAD_COOLDOWN_MS;
}

function lazyPage<M>(load: () => Promise<M>, pick: (module: M) => ComponentType) {
  return async () => {
    try {
      const module = await load();
      sessionStorage.removeItem(RELOAD_STAMP);
      return { Component: pick(module) };
    } catch (error) {
      if (reloadedRecently()) throw error;
      sessionStorage.setItem(RELOAD_STAMP, String(Date.now()));
      // The URL has not committed yet when a lazy route fails, so reloading
      // in place would strand the user on the page they were leaving. The
      // pending navigation carries the real destination — already basename
      // qualified, dynamic segments included — so the fresh document lands
      // where they clicked.
      // Cache-bust: the browser may hold a stale index.html with old chunk
      // hashes. Appending a timestamp forces a fresh fetch so the new chunks
      // are referenced correctly.
      const bust = `_bust=${Date.now()}`;
      const pending = router.state.navigation.location;
      if (pending) {
        const sep = pending.search ? "&" : "?";
        window.location.assign(`${pending.pathname}${pending.search}${sep}${bust}${pending.hash}`);
      } else {
        window.location.assign(`${location.pathname}?${bust}`);
      }
      // The document swap supersedes this navigation, so never settle.
      return new Promise<never>(() => {});
    }
  };
}

export const router = createBrowserRouter(
  [
    { path: "/login", element: <LoginPage />, errorElement: <RouteError /> },
    {
      path: "/",
      element: <AppShell />,
      loader: guardLoader,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <Navigate to="/overview" replace /> },
        { path: "overview", lazy: lazyPage(() => import("../features/overview/page"), (m) => m.OverviewPage) },
        { path: "usage", lazy: lazyPage(() => import("../features/usage/page"), (m) => m.UsagePage) },
        { path: "providers", lazy: lazyPage(() => import("../features/providers/page"), (m) => m.ProvidersPage) },
        { path: "providers/:id", lazy: lazyPage(() => import("../features/providers/detail"), (m) => m.ProviderDetailPage) },
        { path: "quota", lazy: lazyPage(() => import("../features/quota/page"), (m) => m.QuotaPage) },
        { path: "console-log", lazy: lazyPage(() => import("../features/console-log/page"), (m) => m.ConsoleLogPage) },
        { path: "advanced", lazy: lazyPage(() => import("../features/customization/page"), (m) => m.CustomizationPage) },
        { path: "settings", lazy: lazyPage(() => import("../features/settings/page"), (m) => m.SettingsPage) },
        { path: "advanced/automation", lazy: lazyPage(() => import("../features/advanced/automation"), (m) => m.AutomationPage) },
      ],
    },
  ],
  { basename: "/console" },
);
