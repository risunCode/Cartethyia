export type DashboardApp = "landing" | "console" | "share";

/** Resolves the app mounted by the shared index document. */
export function resolveDashboardApp(pathname: string): DashboardApp {
  if (pathname === "/share" || pathname.startsWith("/share/")) return "share";
  return pathname === "/console" || pathname.startsWith("/console/") ? "console" : "landing";
}
