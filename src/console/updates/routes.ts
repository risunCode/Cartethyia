import { Elysia } from "elysia";
import { consoleErrorHandler } from "../shared/errors";
import { fetchLatestRelease } from "./repository-updates";

/**
 * Read-only update discovery for the console sidebar.
 *
 * Public release metadata only — no credentials, no local paths, nothing the
 * caller supplied — so this group needs no session scope. A GitHub failure
 * answers `null` rather than an error: an absent update badge is the honest
 * result when the upstream cannot be reached.
 */
export function createUpdateRoutes(): Elysia {
  return new Elysia()
    .error(consoleErrorHandler("Update check failed"))
    .get("/updates/release", async () => await fetchLatestRelease()) as unknown as Elysia;
}
