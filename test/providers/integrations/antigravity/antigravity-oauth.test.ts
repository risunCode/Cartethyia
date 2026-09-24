import { afterEach, describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_SCOPES,
  AntigravityOAuthClient,
} from "../../../../src/providers/integrations/antigravity/antigravity-oauth";

const ORIGINAL_PUBLIC_ORIGIN = process.env.CARTETHYIA_PUBLIC_ORIGIN;

afterEach(() => {
  if (ORIGINAL_PUBLIC_ORIGIN === undefined) {
    delete process.env.CARTETHYIA_PUBLIC_ORIGIN;
  } else {
    process.env.CARTETHYIA_PUBLIC_ORIGIN = ORIGINAL_PUBLIC_ORIGIN;
  }
});

describe("Antigravity OAuth client", () => {
  test("uses the reference Google OAuth client identity", () => {
    process.env.CARTETHYIA_PUBLIC_ORIGIN = "http://localhost:12800";
    const client = new AntigravityOAuthClient();
    const authorizeUrl = new URL(
      client.buildAuthorizeUrl({ state: "state", codeChallenge: "challenge", redirectUri: "http://127.0.0.1:59653/callback" }),
    );

    expect(ANTIGRAVITY_CLIENT_ID).toBe(
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:59653/callback",
    );
    expect(authorizeUrl.searchParams.get("scope")).toBe(ANTIGRAVITY_SCOPES);
  });
});
