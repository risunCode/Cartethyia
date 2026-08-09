/**
 * Database Map API routes — Elysia sub-app mounted inside the console API.
 *
 * Routes:
 *   GET    /db-map/schema?db=config|runtime          — table/column/index schema
 *   GET    /db-map/tables/:name/rows?db=&limit=&offset= — paginated row read
 *   POST   /db-map/query?db=                          — SELECT-only SQL execution
 *   POST   /db-map/execute?db=                         — DML/DDL SQL execution (transactional)
 *   GET    /db-map/export?db=                          — download raw .sqlite file
 *   POST   /db-map/import?db=                           — upload + validate + replace .sqlite
 *
 * All routes sit behind the console session guard (applied by the parent app).
 * The dashboard adds a client-side password re-auth gate for sensitive data.
 */

import { Elysia, type HTTPHeaders } from "elysia";
import { consoleError } from "../services/composition";
import { getPersistenceEnv } from "../../storage/main/env";
import { DbMapService, type DbMapPersistence } from "./service";
import type { DbTarget } from "./types";

function badRequest(set: { status?: number | string; headers: HTTPHeaders }, message: string) {
  set.status = 400;
  return consoleError("invalid_request", message);
}

function notFound(set: { status?: number | string; headers: HTTPHeaders }, message: string) {
  set.status = 404;
  return consoleError("not_found", message);
}

function internalError(set: { status?: number | string; headers: HTTPHeaders }, message: string) {
  set.status = 500;
  return consoleError("internal_error", message);
}

function resolveTarget(value: unknown): DbTarget | null {
  if (value === "config" || value === "runtime") return value;
  return null;
}

/** Max import payload size for the multipart/raw body read (64 MiB). */
const MAX_IMPORT_BODY_BYTES = 64 * 1024 * 1024;

/** Create the Database Map Elysia sub-app. The service is created once and shared. */
export function createDbMapApi(persistence: DbMapPersistence | null = null): Elysia {
  const service = new DbMapService(getPersistenceEnv(), persistence);
  const app = new Elysia();

  app
    .route("QUERY", "/db-map/schema", ({ query, set }: { query: Record<string, string | undefined>; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const target = resolveTarget(query.db);
      if (!target) return badRequest(set, "db must be 'config' or 'runtime'");
      try {
        return service.getSchema(target);
      } catch (error) {
        return internalError(set, error instanceof Error ? error.message : "schema introspection failed");
      }
    })
    .route("QUERY", "/db-map/tables/:name/rows", ({ params, query, set }: { params: { name: string }; query: Record<string, string | undefined>; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const target = resolveTarget(query.db);
      if (!target) return badRequest(set, "db must be 'config' or 'runtime'");
      const limit = query.limit !== undefined ? parseInt(query.limit, 10) : 100;
      const offset = query.offset !== undefined ? parseInt(query.offset, 10) : 0;
      if (!Number.isFinite(limit) || !Number.isFinite(offset)) return badRequest(set, "limit and offset must be numbers");
      try {
        return service.getTableRows(target, params.name, limit, offset);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "table read failed";
        if (msg.includes("not found") || msg.includes("invalid")) return notFound(set, msg);
        return internalError(set, msg);
      }
    })
    .post("/db-map/query", async ({ query, body, set }: { query: Record<string, string | undefined>; body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const target = resolveTarget(query.db);
      if (!target) return badRequest(set, "db must be 'config' or 'runtime'");
      const sql = typeof body === "object" && body !== null ? (body as Record<string, unknown>).sql : undefined;
      if (typeof sql !== "string" || sql.trim() === "") return badRequest(set, "sql is required");
      try {
        return service.query(target, sql);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "query failed";
        if (msg.includes("allows only") || msg.includes("forbidden")) return badRequest(set, msg);
        return internalError(set, msg);
      }
    })
    .post("/db-map/execute", async ({ query, body, set }: { query: Record<string, string | undefined>; body: unknown; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const target = resolveTarget(query.db);
      if (!target) return badRequest(set, "db must be 'config' or 'runtime'");
      const sql = typeof body === "object" && body !== null ? (body as Record<string, unknown>).sql : undefined;
      if (typeof sql !== "string" || sql.trim() === "") return badRequest(set, "sql is required");
      try {
        return service.execute(target, sql);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "execute failed";
        if (msg.includes("allows only") || msg.includes("forbidden")) return badRequest(set, msg);
        return internalError(set, msg);
      }
    })
    .route("QUERY", "/db-map/export", ({ query, set }: { query: Record<string, string | undefined>; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const target = resolveTarget(query.db);
      if (!target) return badRequest(set, "db must be 'config' or 'runtime'");
      const result = service.exportDb(target);
      if (!result.ok) return internalError(set, result.error);
      // Return raw binary with download headers — Elysia can return a Response
      return new Response(result.data, {
        status: 200,
        headers: {
          "content-type": "application/x-sqlite3",
          "content-disposition": `attachment; filename="${result.filename}"`,
          "cache-control": "no-store",
        },
      });
    })
    .post("/db-map/import", async ({ query, request, set }: { query: Record<string, string | undefined>; request: Request; set: { status?: number | string; headers: HTTPHeaders } }) => {
      const target = resolveTarget(query.db);
      if (!target) return badRequest(set, "db must be 'config' or 'runtime'");

      const contentLength = Number(request.headers.get("content-length") ?? "0");
      if (contentLength > MAX_IMPORT_BODY_BYTES) return badRequest(set, `import file exceeds ${MAX_IMPORT_BODY_BYTES} bytes`);

      // Accept raw body (application/octet-stream) or multipart file upload
      const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
      let data: Uint8Array;

      try {
        if (contentType.includes("multipart/form-data")) {
          const form = await request.formData();
          const file = form.get("file") ?? form.get("database");
          if (typeof file === "string" || file === null) return badRequest(set, "no file uploaded");
          const blob = file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> };
          data = new Uint8Array(await blob.arrayBuffer());
        } else {
          // Raw body — treat as octet-stream
          const buf = await request.arrayBuffer();
          data = new Uint8Array(buf);
        }
      } catch {
        return badRequest(set, "failed to read upload body");
      }

      const result = service.importDb(target, data);
      if (!result.ok) {
        set.status = 400;
        return consoleError("invalid_request", result.error);
      }

      return { ok: true, message: result.message };
    });

  return app;
}
