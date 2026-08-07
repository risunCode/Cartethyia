/**
 * Configuration database schema, idempotent column upgrades, and provider-id
 * migrations.
 *
 * Extracted from `config.ts` so the DDL and schema lifecycle own their own
 * file. The remaining record interfaces, repository builders, durable ports,
 * and lifecycle singletons live in `config.ts`.
 */

import { Database } from "bun:sqlite";
import { sanitizeMessage } from "../../domain/contracts";
import type { ApplicationErrorKind, RouteStatus } from "../../domain/contracts";

export { CONFIG_SCHEMA_SQL } from "./schema.sql";


interface TableNameRow {
  name: string;
}

export function clearAllDatabaseTables(database: Database): void {
  const tables = (database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as TableNameRow[]).map((row) => row.name);
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.transaction(() => {
      for (const table of tables) database.query(`DELETE FROM "${table.replaceAll('"', '""')}"`).run();
      if (database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !== null) database.query("DELETE FROM sqlite_sequence").run();
    })();
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}


export function nowIso(): string {
  return new Date().toISOString();
}

/** Sanitized persistence error — never leaks file paths or credentials. */
export function configError(message: string): Error {
  return new Error(sanitizeMessage(message));
}

export function toRouteStatus(value: string | null | undefined): RouteStatus {
  switch (value) {
    case "healthy":
    case "cooling_down":
    case "error":
    case "disabled":
      return value;
    default:
      return "error";
  }
}

export function toErrorKind(value: string | null | undefined): ApplicationErrorKind | null {
  if (value === null || value === undefined || value === "") return null;
  return value as ApplicationErrorKind;
}

export function orNullString(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}
