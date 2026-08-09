export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory = "web" | "request" | "system";

export type LogCategoryFilter = "all" | LogCategory;

const WEB_SCOPES: Record<string, true> = { http: true, web: true };
const REQUEST_SCOPES: Record<string, true> = { request: true };

export function logCategoryOfScope(scope: string): LogCategory {
  if (WEB_SCOPES[scope] === true) return "web";
  if (REQUEST_SCOPES[scope] === true) return "request";
  return "system";
}

export function isLogCategoryFilter(value: string | null): value is LogCategoryFilter {
  return value === "all" || value === "web" || value === "request" || value === "system";
}

export function logCategorySql(category: LogCategoryFilter): string {
  switch (category) {
    case "web":
      return "scope IN ('http', 'web')";
    case "request":
      return "scope = 'request'";
    case "system":
      return "scope NOT IN ('http', 'web', 'request')";
    case "all":
      return "scope NOT IN ('http', 'web')";
  }
}
