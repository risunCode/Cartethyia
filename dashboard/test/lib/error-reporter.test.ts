import { afterEach, describe, expect, test, vi } from "vitest";

import { reportError } from "../../src/lib/error-reporter";

describe("reportError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("posts the level, message, and context to /console/client-errors", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response(null, { status: 201 }));

    reportError("error", "boom", { source: "test" });
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/console/client-errors",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level: "error", message: "boom", context: { source: "test" } }),
      }),
    );
  });

  test("never throws when the fetch rejects", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    expect(() => reportError("error", "boom")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
