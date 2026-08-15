export const ROUTES = {
  landing: "/",
  consoleLogin: "/console/login",
  consoleOverview: "/console/overview",
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
