export const ROUTES = {
  landing: "/home",
  consoleLogin: "/console/login",
  consoleOverview: "/console/overview",
  consoleUsage: "/console/usage",
  consoleProviders: "/console/providers",
  consoleSettings: "/console/settings",
} as const;

export function isConsolePath(pathname: string): boolean {
  return pathname === "/console" || pathname.startsWith("/console/");
}

export function safeConsoleNextPath(value: string | null | undefined): string {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return "/overview";
  }
  return value;
}
