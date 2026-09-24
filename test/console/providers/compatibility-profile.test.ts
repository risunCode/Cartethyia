// Regression coverage for the compatibility-profile validator: it must enforce
// the canonical protected-header policy (`src/security/outbound-headers.ts`)
// plus the adapter-owned names, and accept ordinary custom headers. The
// validator previously carried its own drifted denylist, so these assertions
// pin the unified policy rather than the copy that used to sit beside it.
import { describe, expect, test } from "bun:test";
import { validateCompatibilityProfile } from "../../../src/console/providers/catalog/contracts";
import type { CompatibilityProfile } from "../../../src/providers/provider-metadata";
import { GatewayError } from "../../../src/transport/gateway-error";

function reject(headers: Readonly<Record<string, string>>): GatewayError {
  try {
    validateCompatibilityProfile({ extra_headers: headers } satisfies CompatibilityProfile);
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error(`expected ${JSON.stringify(headers)} to be rejected`);
}

describe("validateCompatibilityProfile — extra_headers protection", () => {
  test("rejects every name in the canonical protected-header set", () => {
    for (const name of [
      "host",
      "content-type",
      "authorization",
      "x-api-key",
      "cookie",
      "connection",
      "proxy-connection",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "via",
      "forwarded",
      "x-real-ip",
      "x-cartethyia-surface",
      "x-cartethyia-tenant",
    ]) {
      expect(reject({ [name]: "value" }).message).toBe(
        `header ${name} is not allowed as custom header`,
      );
    }
  });

  test("rejects every x-forwarded-* name by prefix", () => {
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "x-forwarded-prefix",
      "x-forwarded-anything",
    ]) {
      expect(reject({ [name]: "value" }).message).toBe(
        `header ${name} is not allowed as custom header`,
      );
    }
  });

  test("rejects adapter-owned names", () => {
    for (const name of [
      "anthropic-version",
      "anthropic-beta",
      "x-stainless-os",
      "x-account-id",
      "x-app",
      "originator",
      "openai-beta",
    ]) {
      expect(reject({ [name]: "value" }).message).toBe(
        `header ${name} is not allowed as custom header`,
      );
    }
  });

  test("matches protected names case-insensitively", () => {
    const error = reject({ Authorization: "value" });
    expect(error.code).toBe("invalid_request");
    expect(error.status).toBe(400);
    expect(error.message).toBe("header Authorization is not allowed as custom header");
  });

  test("accepts ordinary custom headers", () => {
    expect(() =>
      validateCompatibilityProfile({
        extra_headers: { "x-custom-header": "value", "x-routing-hint": "1" },
      } satisfies CompatibilityProfile),
    ).not.toThrow();
  });
});

describe("validateCompatibilityProfile — cli_identity", () => {
  test("accepts the boolean flag the dashboard always sends", () => {
    // Every custom-provider create/update carries `cli_identity`; rejecting it
    // here surfaced as "unknown compatibility_profile field cli_identity has no
    // runtime reader" even though `resolveCustomCliHeaders` reads it.
    expect(() =>
      validateCompatibilityProfile({ cli_identity: true } satisfies CompatibilityProfile),
    ).not.toThrow();
    expect(() =>
      validateCompatibilityProfile({ cli_identity: false } satisfies CompatibilityProfile),
    ).not.toThrow();
  });

  test("rejects a non-boolean value with a typed 400", () => {
    const error = (() => {
      try {
        validateCompatibilityProfile({
          cli_identity: "yes",
        } as unknown as CompatibilityProfile);
      } catch (caught) {
        return caught as GatewayError;
      }
      throw new Error("expected cli_identity string to be rejected");
    })();
    expect(error).toBeInstanceOf(GatewayError);
    expect(error.code).toBe("invalid_request");
    expect(error.status).toBe(400);
    expect(error.message).toBe("cli_identity must be boolean");
  });
});
