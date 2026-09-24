export type DashboardApp = "landing" | "console";

/** Resolves the app mounted by the shared index document. */
export function resolveDashboardApp(pathname: string): DashboardApp {
  return pathname === "/console" || pathname.startsWith("/console/") ? "console" : "landing";
}
