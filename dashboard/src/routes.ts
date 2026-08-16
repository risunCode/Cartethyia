export const ROUTES = {
  login: "/login",
} as const;

export function safeConsoleNextPath(value: string | null | undefined): string {
  if (!value || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return "/overview";
  }
  return value;
}
