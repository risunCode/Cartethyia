import { describe, expect, test } from "bun:test";
import { DIRECT_ADAPTER_EXCEPTIONS } from "../../src/open-sse/translate";

describe("direct adapter policy", () => {
  test("every non-JSON bypass has an explicit tested boundary", () => {
    expect(DIRECT_ADAPTER_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const exception of DIRECT_ADAPTER_EXCEPTIONS) {
      expect(exception.providerId.length).toBeGreaterThan(0);
      expect(exception.surfaces.length).toBeGreaterThan(0);
      expect(exception.reason.length).toBeGreaterThan(10);
      expect(["protocol-decoder", "auth-exchange", "binary-transport", "search-api", "media-api"]).toContain(exception.sharedPolicyBoundary);
    }
  });
});
