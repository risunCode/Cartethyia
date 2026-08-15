import { consoleError, type ConsoleServices } from "../services/composition";
import type { ConsoleErrorBody } from "../views/errors";

export interface ConsoleRouteSet {
  status?: number | string;
}

export function ok(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, ...extra };
}

export function notFound(set: ConsoleRouteSet, message = "resource not found"): ConsoleErrorBody {
  set.status = 404;
  return consoleError("not_found", message);
}

export function badRequest(set: ConsoleRouteSet, message: string): ConsoleErrorBody {
  set.status = 400;
  return consoleError("invalid_request", message);
}

export function conflict(set: ConsoleRouteSet, message: string): ConsoleErrorBody {
  set.status = 409;
  return consoleError("conflict", message);
}

export function internalError(set: ConsoleRouteSet, message: string): ConsoleErrorBody {
  set.status = 500;
  return consoleError("internal_error", message);
}

export async function resolveProviderId(services: ConsoleServices, id: string): Promise<string> {
  const custom = (await services.providers.listCustom()).find((provider) => provider.id === id || provider.slug === id);
  return custom?.slug ?? id;
}
