// Coverage for the compatibility-profile validator's remaining field arms.
// `test/console/providers/compatibility-profile.test.ts` already pins the
// `extra_headers` protected-name policy and `cli_identity`; this file covers
// the query-param, endpoint-path, model-rule, streaming and unknown-field
// decisions that decide whether a persisted provider profile is accepted.
import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_STATUSES,
  CREDENTIAL_KINDS,
  isWireFamily,
  validateCompatibilityProfile,
} from "../../../../src/console/providers/catalog/contracts";
import type { CompatibilityProfile } from "../../../../src/providers/provider-metadata";
import { GatewayError } from "../../../../src/transport/gateway-error";

/**
 * Runs the validator and returns the rejection. Typed through `unknown` at the
 * boundary because the validator's contract is "throws GatewayError", not
 * "returns an error object".
 */
function reject(profile: unknown): GatewayError {
  try {
    validateCompatibilityProfile(profile as CompatibilityProfile);
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error(`expected ${JSON.stringify(profile)} to be rejected`);
}

function accept(profile: unknown): void {
  expect(() => validateCompatibilityProfile(profile as CompatibilityProfile)).not.toThrow();
}

describe("validateCompatibilityProfile — credentialUrl", () => {
  test("rejects a non-string credential URL before the allow-list runs", () => {
    // The dashboard can post this field, so a numeric value must be rejected
    // rather than persisted as a truthy non-URL.
    expect(reject({ credentialUrl: 42 }).message).toBe("credentialUrl must be string");
  });

  test("a well-formed credentialUrl is still rejected by the unknown-field allow-list", () => {
    // Observed inconsistency, pinned so a fix is deliberate: `credentialUrl`
    // is validated above and then rejected below because it is missing from
    // the `allowed` map. A provider profile carrying a credential URL cannot
    // be persisted today. Reported, not silently repaired.
    expect(reject({ credentialUrl: "https://console.example/keys" }).message).toBe(
      "unknown compatibility_profile field credentialUrl has no runtime reader",
    );
  });
});

describe("validateCompatibilityProfile — gateway_user_agent", () => {
  test("accepts either boolean value", () => {
    accept({ gateway_user_agent: true });
    accept({ gateway_user_agent: false });
  });

  test("rejects a non-boolean gateway_user_agent", () => {
    expect(reject({ gateway_user_agent: "yes" }).message).toBe(
      "gateway_user_agent must be boolean",
    );
  });
});

describe("validateCompatibilityProfile — extra_query_params", () => {
  test("accepts ordinary string params", () => {
    accept({ extra_query_params: { "api-version": "2024-10-21", trace: "on" } });
  });

  test("rejects a non-string value", () => {
    expect(reject({ extra_query_params: { limit: 10 } }).message).toBe(
      "query param limit must be string",
    );
  });

  test("rejects CRLF smuggled in a key or a value", () => {
    // A CRLF in a query param rewrites the request line, so both sides are
    // checked, not just the value.
    expect(reject({ extra_query_params: { "a\r\nb": "v" } }).message).toBe(
      "query param contains CRLF",
    );
    expect(reject({ extra_query_params: { k: "v\r\nX-Injected: 1" } }).message).toBe(
      "query param contains CRLF",
    );
  });
});

describe("validateCompatibilityProfile — endpoint_paths_by_wire_family", () => {
  test("accepts absolute paths for known wire families", () => {
    accept({
      endpoint_paths_by_wire_family: { chat: "/v1/chat/completions", messages: "/v1/messages" },
    });
  });

  test("rejects an unknown wire family", () => {
    expect(
      reject({ endpoint_paths_by_wire_family: { telepathy: "/v1/telepathy" } }).message,
    ).toBe("endpoint_paths_by_wire_family: unknown wire family telepathy");
  });

  test("rejects a non-string path", () => {
    expect(reject({ endpoint_paths_by_wire_family: { chat: 7 } }).message).toBe(
      "endpoint_paths_by_wire_family.chat must be string",
    );
  });

  test("rejects an empty or oversized path", () => {
    expect(reject({ endpoint_paths_by_wire_family: { chat: "" } }).message).toBe(
      "endpoint_paths_by_wire_family.chat path length must be 1-256 chars",
    );
    expect(
      reject({ endpoint_paths_by_wire_family: { chat: `/${"a".repeat(256)}` } }).message,
    ).toBe("endpoint_paths_by_wire_family.chat path length must be 1-256 chars");
  });

  test("rejects a relative path", () => {
    expect(reject({ endpoint_paths_by_wire_family: { chat: "v1/chat" } }).message).toBe(
      "endpoint_paths_by_wire_family.chat path must start with /",
    );
  });

  test("rejects whitespace or control characters inside a path", () => {
    // A space or CR would break out of the request line once concatenated.
    expect(reject({ endpoint_paths_by_wire_family: { chat: "/v1/chat x" } }).message).toBe(
      "endpoint_paths_by_wire_family.chat path contains invalid characters",
    );
    expect(reject({ endpoint_paths_by_wire_family: { chat: "/v1/x\r\nHost: evil" } }).message).toBe(
      "endpoint_paths_by_wire_family.chat path contains invalid characters",
    );
  });
});

describe("validateCompatibilityProfile — model_wire_families", () => {
  test("a well-formed rule array is still rejected by the unknown-field allow-list", () => {
    // Observed inconsistency, pinned so a fix is deliberate: the field is
    // validated above and then rejected below because `model_wire_families`
    // is missing from the `allowed` map, so any provider profile carrying a
    // rule set cannot be persisted at all. Reported, not silently repaired.
    expect(
      reject({
        model_wire_families: [
          { pattern: "^gpt-5", wire_family: "responses" },
          { pattern: "^claude-", wire_family: "messages" },
        ],
      }).message,
    ).toBe("unknown compatibility_profile field model_wire_families has no runtime reader");
  });

  test("rejects a non-array value", () => {
    expect(reject({ model_wire_families: { pattern: "^gpt" } }).message).toBe(
      "model_wire_families must be an array",
    );
  });

  test("rejects a missing or empty pattern", () => {
    expect(reject({ model_wire_families: [{ wire_family: "chat" }] }).message).toBe(
      "model_wire_families[].pattern must be a non-empty string",
    );
    expect(reject({ model_wire_families: [{ pattern: "", wire_family: "chat" }] }).message).toBe(
      "model_wire_families[].pattern must be a non-empty string",
    );
  });

  test("rejects an oversized pattern", () => {
    expect(
      reject({ model_wire_families: [{ pattern: "a".repeat(257), wire_family: "chat" }] }).message,
    ).toBe("model_wire_families[].pattern must be at most 256 chars");
  });

  test("rejects a pattern that is not a valid regular expression", () => {
    expect(
      reject({ model_wire_families: [{ pattern: "([unclosed", wire_family: "chat" }] }).message,
    ).toBe("model_wire_families[].pattern ([unclosed is not a valid regular expression");
  });

  test("rejects an unknown wire family on a rule", () => {
    expect(
      reject({ model_wire_families: [{ pattern: "^x", wire_family: "telepathy" }] }).message,
    ).toBe("model_wire_families[].wire_family: unknown wire family telepathy");
  });
});

describe("validateCompatibilityProfile — streaming_usage_mode and structured_output", () => {
  test("rejects an undeclared streaming mode", () => {
    expect(reject({ streaming_usage_mode: "always" }).message).toBe(
      "invalid streaming_usage_mode",
    );
  });

  test("rejects a structured_output whose enabled flag is not a boolean", () => {
    expect(
      reject({ structured_output: { mode: "json_object", enabled: "yes" } }).message,
    ).toBe("structured_output.enabled must be boolean");
  });

  test("both fields are absent from the unknown-field allow-list, so a valid value is still rejected", () => {
    // Observed inconsistency, pinned so a fix is deliberate: the two fields are
    // validated above but omitted from `allowed` below, so their declared
    // values cannot pass. Reported, not silently repaired.
    expect(reject({ streaming_usage_mode: "include_usage" }).message).toBe(
      "unknown compatibility_profile field streaming_usage_mode has no runtime reader",
    );
    expect(reject({ streaming_usage_mode: "none" }).message).toBe(
      "unknown compatibility_profile field streaming_usage_mode has no runtime reader",
    );
    expect(
      reject({ structured_output: { mode: "json_schema", enabled: true } }).message,
    ).toBe("unknown compatibility_profile field structured_output has no runtime reader");
  });
});

describe("validateCompatibilityProfile — unknown fields", () => {
  test("accepts a profile built only from fields with a runtime reader", () => {
    accept({
      extra_headers: { "x-tenant": "acme" },
      extra_query_params: { region: "eu" },
      endpoint_paths_by_wire_family: { chat: "/v1/chat/completions" },
      cli_identity: true,
      gateway_user_agent: false,
    });
  });

  test("rejects a field no reader consumes, naming the field", () => {
    // Persisting an unknown key would silently drop it at runtime, so the
    // validator fails the write instead of accepting a no-op setting.
    expect(reject({ made_up_setting: true }).message).toBe(
      "unknown compatibility_profile field made_up_setting has no runtime reader",
    );
  });

  test("accepts an empty profile", () => {
    accept({});
  });
});
describe("catalog runtime vocabularies", () => {
  test("credential kinds cover api_key, oauth, and none in order", () => {
    expect([...CREDENTIAL_KINDS]).toEqual(["api_key", "oauth", "none"]);
  });

  test("operator-settable account statuses exclude health-machine-only states", () => {
    // `degraded` and `cooldown` are set by the health machine, never by an
    // operator patch, so they must not be accepted as a PATCH status.
    expect([...ACCOUNT_STATUSES]).toEqual(["active", "disabled"]);
  });

  test("isWireFamily accepts exactly the canonical families", () => {
    for (const family of ["chat", "responses", "messages"]) {
      expect(isWireFamily(family)).toBe(true);
    }
    for (const value of ["", "CHAT", "telepathy", 1, null, undefined, {}]) {
      expect(isWireFamily(value)).toBe(false);
    }
  });
});
