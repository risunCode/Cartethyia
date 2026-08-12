import { describe, expect, test } from "bun:test";
import { MapAuthDriverRegistry } from "../../src/application/auth/drivers";
import { OAuthLoginSessionManager, type OAuthCompleteSessionInput } from "../../src/application/auth/oauth-sessions";
import { registerOAuthCallback, unregisterOAuthCallback } from "../../src/application/auth/oauth-callback-server";

const CALLBACK_URL = "http://127.0.0.1:54545/callback";

function createSessionManager(): OAuthLoginSessionManager {
  return new OAuthLoginSessionManager({ drivers: new MapAuthDriverRegistry() });
}

describe("OAuth callback security", () => {
  test("requires exact state and redacts provider failure details", async () => {
    const sessionManager = createSessionManager();
    const sessionId = "callback-security-test";
    const onComplete = async (_id: string, _input: OAuthCompleteSessionInput): Promise<void> => {
      throw new Error("upstream Bearer provider-secret-value");
    };
    registerOAuthCallback("claude", sessionId, "state-expected", sessionManager, onComplete);

    try {
      const missingState = await fetch(CALLBACK_URL);
      const wrongState = await fetch(`${CALLBACK_URL}?state=state-wrong&code=code`);
      const validState = await fetch(`${CALLBACK_URL}?state=state-expected&code=code`);
      const body = await validState.text();

      expect(missingState.status).toBe(400);
      expect(wrongState.status).toBe(400);
      expect(validState.status).toBe(500);
      expect(body).toBe("OAuth login failed. Return to the application and try again.");
      expect(body).not.toContain("provider-secret-value");
    } finally {
      unregisterOAuthCallback("claude", sessionId);
    }
  });
  test("does not run device polling for browser OAuth sessions", async () => {
    let pollCalls = 0;
    const registry = new MapAuthDriverRegistry();
    registry.register("codex", {
      kind: "oauth",
      capabilities: {
        supportsStart: true,
        supportsPoll: true,
        supportsExchange: true,
        supportsRefresh: true,
        supportsRevoke: false,
        accessOnly: false,
        supportsBrowser: true,
        supportsDevice: true,
      },
      start: async () => ({
        authorizationUrl: "https://auth.example.test/authorize",
        state: "browser-state",
        expiresAtMs: Date.now() + 60_000,
        flow: "browser",
      }),
      poll: async () => {
        pollCalls += 1;
        return { status: "expired" };
      },
    });
    const sessionManager = new OAuthLoginSessionManager({ drivers: registry });
    const started = await sessionManager.start({ providerId: "codex", name: "Codex browser", flow: "browser" });
    const status = await sessionManager.poll(started.sessionId);

    expect(status.status).toBe("waiting-for-user");
    expect(pollCalls).toBe(0);
  });
});
