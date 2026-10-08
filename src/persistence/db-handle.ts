/** Shared database handle: the seam every store runs on top of. */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/** Complete Drizzle schema object: every table across the single schema source. */
export const fullSchema = schema;

/**
 * Drizzle instance behind the handle. Declared as the node-postgres shape
 * because that is what every store was written against. The SQLite backend's
 * builder is a different type, so it asserts its instance to this type once,
 * at creation, instead of forcing a union through ~30 transaction call sites.
 * The assertion is the seam, not a claim that the builders are identical: a
 * store that reaches past the surface both drivers implement fails its
 * SQLite run rather than typechecking clean and breaking at boot.
 */
export type CartethyiaDatabase = NodePgDatabase<typeof fullSchema>;

/** Raw rows from a parameter query, without driver-specific decoration. */
export interface QueryRows {
  readonly rows: unknown[];
}

/**
 * One open database behind the `CartethyiaDatabase` instance. Stores only ever
 * see `db`; the runner and health checks use `query`/`exec`; `close` is
 * shutdown-symmetric per backend.
 */
export interface DatabaseHandle {
  readonly kind: "pg" | "sqlite";
  readonly db: CartethyiaDatabase;
  /**
   * The raw bun:sqlite database, present only on the SQLite backend. A hot
   * reload keeps this handle and has to rebuild it to repatch the column
   * mapping the reload discarded.
   */
  readonly sqlite?: import("bun:sqlite").Database;
  /**
   * Present only on the SQLite backend: the auth lookups prepared once at
   * boot. The PostgreSQL backend has no equivalent and the store falls back
   * to the query builder, so this stays optional.
   */
  readonly auth?: import("./db-sqlite").SqliteAuthStatements;
  query: (text: string, params?: readonly unknown[]) => Promise<QueryRows>;
  exec: (script: string) => Promise<void>;
  close: () => Promise<void>;
}
