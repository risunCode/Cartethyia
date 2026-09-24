import { ValidationError } from "elysia";
import type { AccessDecision, AccessScope } from "../../security/access-control";
import { isRecord } from "../../protocol/primitives";

// Single console error/access contract. Every domain throws ConsoleDomainError
// (or the storage-layer BackupError, same code/status/message shape) and
// shapes it through errorResponse; guards narrow to TenantAccessDecision.

export interface ErrorResponseOptions {
  readonly detailsPolicy?: "omit" | "include-if-present" | "always-include";
  readonly origin?: "internal" | "upstream";
}

export class ConsoleDomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ConsoleDomainError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function asDomainError(error: unknown): { code: string; status: number; message: string; details?: unknown } | undefined {
  if (error instanceof ConsoleDomainError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { status?: unknown }).status === "number" &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const shaped = error as { code: string; status: number; message: string; details?: unknown };
    return { code: shaped.code, status: shaped.status, message: shaped.message, details: shaped.details };
  }
  return undefined;
}

export function errorResponse(
  error: unknown,
  set: { status?: number | string },
  fallbackMessage: string,
  options: ErrorResponseOptions = {},
): {
  error: string;
  code: string;
  details?: Record<string, unknown>;
} {
  const prefix = options.origin === "upstream" ? "Upstream Error:" : "Cartethyia Error:";
  const shaped = asDomainError(error);
  if (shaped) {
    set.status = shaped.status;
    const message = shaped.message.startsWith("Cartethyia Error:") || shaped.message.startsWith("Upstream Error:")
      ? shaped.message
      : `${prefix} ${shaped.message}`;
    const details = isRecord(shaped.details) ? shaped.details : undefined;
    const includeDetails =
      options.detailsPolicy === "always-include"
        ? true
        : options.detailsPolicy === "omit"
          ? false
          : details !== undefined;
    const body: Record<string, unknown> = {
      error: message,
      code: shaped.code,
    };
    if (includeDetails) body.details = details;
    return body as { error: string; code: string; details?: Record<string, unknown> };
  }
  set.status = 500;
  const body: Record<string, unknown> = {
    error: `${prefix} ${fallbackMessage}`,
    code: "internal_error",
  };
  return body as { error: string; code: string; details?: Record<string, unknown> };
}

export function requireScope(
  access: AccessDecision | undefined,
  scope: AccessScope,
): AccessDecision {
  if (!access) throw new ConsoleDomainError("unauthorized", 401, "Authentication required");
  if (!access.scopes.includes(scope))
    throw new ConsoleDomainError("insufficient_scope", 403, `${scope} scope required`);
  return access;
}

/**
 * Requires at least one of `scopes`.
 *
 * Catalog routes are reachable from two principals whose scope vocabularies
 * differ: a browser session holds `dashboard:write`, while a tenant API key is
 * granted `providers:write`/`models:write`. Neither implies the other — the
 * point of the separate catalog scopes is that a key able to read usage cannot
 * thereby add an upstream — so the route accepts either and the message names
 * every acceptable scope rather than one that would be wrong for the caller.
 */
export function requireAnyScope(
  access: AccessDecision | undefined,
  scopes: readonly AccessScope[],
): AccessDecision {
  if (!access) throw new ConsoleDomainError("unauthorized", 401, "Authentication required");
  if (!scopes.some((scope) => access.scopes.includes(scope)))
    throw new ConsoleDomainError("insufficient_scope", 403, `${scopes.join(" or ")} scope required`);
  return access;
}

export type TenantAccessDecision = AccessDecision & { readonly tenantId: string };

export function requireTenantScope(
  access: AccessDecision | undefined,
  scope: "dashboard:read" | "dashboard:write",
): TenantAccessDecision {
  const narrowed = requireScope(access, scope);
  if (narrowed.tenantId === null) {
    throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
  }
  return { ...narrowed, tenantId: narrowed.tenantId };
}

/** Tenant-narrowing variant of {@link requireAnyScope}. */
export function requireTenantAnyScope(
  access: AccessDecision | undefined,
  scopes: readonly AccessScope[],
): TenantAccessDecision {
  const narrowed = requireAnyScope(access, scopes);
  if (narrowed.tenantId === null) {
    throw new ConsoleDomainError("tenant_required", 403, "Tenant isolation required");
  }
  return { ...narrowed, tenantId: narrowed.tenantId };
}
/** Requires an explicitly platform-admin, tenant-independent operation. */
export function requireGlobalAdmin(access: AccessDecision | undefined): AccessDecision {
  if (!access) throw new ConsoleDomainError("unauthorized", 401, "Authentication required");
  if (!access.scopes.includes("platform:admin")) {
    throw new ConsoleDomainError("insufficient_scope", 403, "platform:admin scope required");
  }
  return access;
}

/**
 * Builds the console's catch-all error handler for an Elysia route group.
 *
 * Every console route group used to wrap each handler in its own try/catch
 * calling `errorResponse` with a group-specific fallback message — 95 copies,
 * 22 of them in one file. Elysia's global `error(handler)` hook receives any
 * throw from the group (including a `.use()`d child), so one hook per group
 * produces the identical envelope with the identical fallback text.
 *
 * Two cases need explicit handling because they reach this hook but are not
 * console domain errors:
 * - A request-schema failure is the caller's `422`, so it is shaped as an
 *   `invalid_request` rather than falling through to a 500.
 * - Elysia's own control-flow throws (not-found, parse errors) carry a numeric
 *   status and must keep their meaning.
 *
 * `fallbackMessage` is what any other throw reports as its 500 message, so a
 * failure still names the area instead of reading as a bare internal error.
 */
export function consoleErrorHandler(fallbackMessage: string) {
  return ({
    error,
    set,
  }: {
    error: unknown;
    set: { status?: number | string };
  }): { error: string; code: string; details?: Record<string, unknown> } => {
    if (error instanceof ValidationError) {
      set.status = 422;
      return { error: `${fallbackMessage}: ${error.message}`, code: "invalid_request" };
    }
    return errorResponse(error, set, fallbackMessage);
  };
}
