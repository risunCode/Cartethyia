import { describe, expect, test } from "bun:test";
import { clientIp, configuredPublicOrigin, isSameOriginRequest } from "../src/console/session";

describe("client IP extraction", () => {
  test("ignores forwarded headers for local requests unless trustProxy is enabled", () => {
    const request = new Request("http://127.0.0.1:12800/v1/chat/completions", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });

    expect(clientIp(request, false, {})).toBe("127.0.0.1");
    expect(clientIp(request, true, {})).toBe("203.0.113.10");
  });

  test("does not infer proxy trust from a platform environment variable", () => {
    const request = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      headers: { "x-forwarded-for": "198.51.100.7" },
    });

    expect(clientIp(request, false, { RAILWAY_ENVIRONMENT_NAME: "production" })).toBe("127.0.0.1");
  });

  test("requires the configured public origin for forwarded console requests", () => {
    const request = new Request("http://127.0.0.1:8080/console/api/settings", {
      method: "POST",
      headers: {
        origin: "https://cartethyia.example",
        host: "127.0.0.1:8080",
        "x-forwarded-host": "cartethyia.example",
      },
    });

    expect(configuredPublicOrigin({ PUBLIC_ORIGIN: "https://cartethyia.example" })).toBe("https://cartethyia.example");
    expect(isSameOriginRequest(request, true, { PUBLIC_ORIGIN: "https://cartethyia.example" })).toBe(true);
    expect(isSameOriginRequest(request, true, { PUBLIC_ORIGIN: "https://evil.example" })).toBe(false);
  });
});
