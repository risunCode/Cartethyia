import { describe, expect, test } from "vitest";
import { parseConsoleEvidence } from "../../../src/composables/observability/use-console-observability";

describe("console evidence parser", () => {
  test("drops attacker-controlled provider payloads from evidence messages", () => {
    const evidence = parseConsoleEvidence({
      id: "event-1",
      timestamp: "2026-08-13T00:00:00Z",
      event: "failure",
      level: "error",
      message: "provider_response: api_key=must-not-enter-dashboard",
    });

    expect(evidence?.message).toBeNull();
  });

  test("keeps bounded non-secret operator messages", () => {
    const evidence = parseConsoleEvidence({
      id: "event-2",
      timestamp: "2026-08-13T00:00:00Z",
      event: "failure",
      level: "warn",
      message: "upstream request failed",
    });

    expect(evidence?.message).toBe("upstream request failed");
  });
});
