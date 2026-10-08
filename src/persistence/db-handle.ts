/** Shared database handle: the seam every store runs on top of. */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/** Complete Drizzle schema object: every table across the single schema source. */
export const fullSchema = schema;

/**
 * Drizzle instance behind the handle. Declared as the node-postgres shape on
 * purpose: both drivers extend the same pg-core `PgDatabase` base over the
 * same schema, so every query builder is identical and only the session
 * differs. The PGlite backend asserts its instance to this type once, at
 * creation, instead of forcing a union through ~30 transaction call sites.
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
  readonly kind: "pg" | "pglite";
  readonly db: CartethyiaDatabase;
  query: (text: string, params?: readonly unknown[]) => Promise<QueryRows>;
  exec: (script: string) => Promise<void>;
  close: () => Promise<void>;
}
