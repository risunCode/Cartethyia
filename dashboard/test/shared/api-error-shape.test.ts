import { describe, expect, test } from "bun:test";
import { fallbackRequestMessage } from "../../src/data/api";

/**
 * A 502 is the upstream's refusal relayed by the gateway. The fallback used to
 * read "Console request failed (502)" for every status, so an operator debugging
 * a rejected account was told the console was broken.
 */
describe("fallbackRequestMessage", () => {
  test("a 502 with no origin is the upstream's failure, not the console's", () => {
    expect(fallbackRequestMessage(502)).toBe("Upstream request failed (502)");
  });

  test("an explicit upstream origin says so at any status", () => {
    expect(fallbackRequestMessage(401, "upstream")).toBe("Upstream request failed (401)");
  });

  test("a console-produced status stays blamed on the console", () => {
    expect(fallbackRequestMessage(400)).toBe("Console request failed (400)");
    expect(fallbackRequestMessage(500, "cartethyia")).toBe("Console request failed (500)");
  });

  test("a network origin names the network", () => {
    expect(fallbackRequestMessage(502, "network")).toBe("Network request failed (502)");
  });
});
