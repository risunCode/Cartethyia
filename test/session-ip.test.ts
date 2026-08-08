import { describe, expect, test } from "bun:test";
import { clientIp, isRailwayRuntime, isSameOriginRequest } from "../src/console/session";

const railwayEnv = { RAILWAY_ENVIRONMENT_NAME: "production" };

describe("client IP extraction", () => {
  test("ignores forwarded headers for local requests unless trustProxy is enabled", () => {
    const request = new Request("http://127.0.0.1:12800/v1/chat/completions", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });

    expect(clientIp(request, false, {})).toBe("127.0.0.1");
    expect(clientIp(request, true, {})).toBe("203.0.113.10");
  });

  test("trusts Railway forwarded client IP and skips malformed entries", () => {
    const request = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      headers: { "x-forwarded-for": "not-an-ip, 198.51.100.7, 203.0.113.4" },
    });

    expect(isRailwayRuntime(railwayEnv)).toBe(true);
    expect(clientIp(request, false, railwayEnv)).toBe("198.51.100.7");
  });

  test("Railway forwarded host participates in console same-origin checks", () => {
    const request = new Request("http://127.0.0.1:8080/console/api/settings", {
      method: "POST",
      headers: {
        origin: "https://cartethyia.example",
        host: "127.0.0.1:8080",
        "x-forwarded-host": "cartethyia.example",
      },
    });

    expect(isSameOriginRequest(request, false, railwayEnv)).toBe(true);
  });
});
