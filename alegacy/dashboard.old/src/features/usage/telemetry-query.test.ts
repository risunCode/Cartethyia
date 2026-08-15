import { describe, expect, it } from "vitest";
import { serializeTelemetryQuery } from "../../composables/usage/use-usage-resource";

describe("serializeTelemetryQuery", () => {
  it("serializes bounded filters in a stable order", () => {
    expect(
      serializeTelemetryQuery({
        from: "2026-08-13T10:00:00Z",
        to: "2026-08-13T11:00:00Z",
        period: "24h",
        bucket: "hour",
        cursor: "page-2",
        limit: 200,
        groupBy: "provider",
      }),
    ).toBe(
      "from=2026-08-13T10%3A00%3A00Z&to=2026-08-13T11%3A00%3A00Z&period=24h&bucket=hour&cursor=page-2&limit=200&group_by=provider",
    );
  });

  it("clamps limits and discards unbounded filter values", () => {
    expect(
      serializeTelemetryQuery({
        from: "\nsecret",
        cursor: "x".repeat(129),
        limit: 10000,
        groupBy: "provider",
      }),
    ).toBe("limit=1000&group_by=provider");
  });
});
