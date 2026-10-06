import { Elysia, t } from "elysia";
import { ConsoleDomainError, consoleErrorHandler } from "../shared/errors";
import { USAGE_DIMENSIONS, type UsageDimension } from "./usage-dimensions";
import { createObservabilityOperations, type ObservabilityConfig } from "./contracts";

const usageQuery = t.Object({ period: t.Optional(t.String()) });
const telemetryListQuery = t.Object({
  period: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  cursor: t.Optional(t.String()),
});
const usageRequestsQuery = t.Object({
  period: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  httpStatus: t.Optional(t.String()),
});
const telemetryDetailQuery = t.Object({
  includePayload: t.Optional(t.String()),
  createdAt: t.Optional(t.String()),
});
export function createObservabilityRoutes(config: ObservabilityConfig): Elysia {
  const factory = createObservabilityOperations(config);
  return new Elysia()
    .error(consoleErrorHandler("Observability operation failed"))
    .get("/system/health", async ({ request }) => {
      return await factory.getSystemHealth(config.accessResolver(request));
})
    .get("/system/usage", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getTenantUsage(config.accessResolver(request), query.period);
})
    .get("/system/usage/summary", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getUsageSummary(config.accessResolver(request), query.period);
})
    .get("/system/usage/chart", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getUsageChart(config.accessResolver(request), query.period);
})
    // One `by-<dimension>` route per member of `USAGE_DIMENSIONS`, so a new
    // dimension cannot be added to the validator without its route existing.
    .get(
      "/system/usage/by-:dimension",
      { query: usageQuery, params: t.Object({ dimension: t.String() }) },
      async ({ request, params, query }) => {
        const dimension = params.dimension as UsageDimension;
        if (!(USAGE_DIMENSIONS as readonly string[]).includes(dimension)) {
          throw new ConsoleDomainError(
            "invalid_dimension",
            404,
            `Unknown usage dimension: ${dimension}`,
          );
        }
        return await factory.getUsageBy(config.accessResolver(request), dimension, query.period);
},
    )
    .get("/system/usage/cache", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getUsageCache(config.accessResolver(request), query.period);
})
    .get("/system/usage/requests", { query: usageRequestsQuery }, async ({ request, query }) => {
      return await factory.listUsageRequests(
        config.accessResolver(request),
        query.period,
        query.limit,
        query.httpStatus,
      );
})
    .get("/system/usage/requests/:requestId", async ({ request, params }) => {
      return await factory.getUsageRequestDetail(config.accessResolver(request), params.requestId);
})
    .get("/telemetry/events", { query: telemetryListQuery }, async ({ request, query }) => {
      return await factory.listEvents(
        config.accessResolver(request),
        query.limit,
        query.cursor,
      );
})
    .get(
      "/telemetry/events/:eventId",
      { query: telemetryDetailQuery },
      async ({ request, params, query }) => {
        return await factory.getEventDetail(
          config.accessResolver(request),
          params.eventId,
          query.includePayload === "true",
          query.createdAt,
        );
},
    ) as unknown as Elysia;
}
