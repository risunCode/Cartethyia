// Console authentication, sessions, lockouts, first-boot setup, and audit.
import type { ConsoleSession, ConsoleUser } from "../../persistence/schema";

import { isRecord } from "../../protocol/codecs";

export function asDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return undefined;
}

export function sessionRecord(value: unknown): ConsoleSession | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.sessionToken !== "string"
  ) {
    return undefined;
  }
  const expiresAt = asDate(value.expiresAt);
  const createdAt = asDate(value.createdAt);
  if (!expiresAt || !createdAt) return undefined;
  return { ...value, expiresAt, createdAt } as unknown as ConsoleSession;
}

export function userRecord(value: unknown): ConsoleUser | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.username !== "string" ||
    typeof value.passwordHash !== "string" ||
    typeof value.isActive !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as ConsoleUser;
}

export function mutationAffectedRows(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["rowCount", "rowsAffected", "changes"] as const) {
    const count = value[key];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) return count;
  }
  return undefined;
}

/** Awaitable Drizzle mutation builder that may expose `.returning()`. */
export interface ReturningBuilder extends PromiseLike<unknown> {
  returning?: (...columns: unknown[]) => PromiseLike<unknown[]>;
}

export async function returningRows(
  builder: ReturningBuilder,
): Promise<{ rows: unknown[]; supported: boolean; affectedRows?: number }> {
  if (typeof builder.returning === "function") {
    return { rows: await builder.returning(), supported: true };
  }
  const result = await builder;
  const affectedRows = mutationAffectedRows(result);
  return affectedRows === undefined
    ? { rows: [], supported: false }
    : { rows: [], supported: false, affectedRows };
}

export function assertMutationApplied(
  result: { rows: unknown[]; supported: boolean; affectedRows?: number },
  operation: string,
): void {
  const applied = result.supported ? result.rows.length > 0 : result.affectedRows === 1;
  if (!applied) throw new Error(`${operation} was not persisted`);
}
