import { describe, expect, test } from "bun:test";
import { MapAuthDriverRegistry } from "../src/application/auth/drivers";
import { OAuthLoginSessionManager, type OAuthCompleteSessionInput } from "../src/application/auth/oauth-sessions";
import { registerOAuthCallback, unregisterOAuthCallback } from "../src/application/auth/oauth-callback-server";

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
});
