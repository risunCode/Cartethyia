import { describe, expect, test } from "bun:test";
import {
  isProbeRequest,
  usageApiKeyLabel,
  usageClientLabel,
  type UsageKeyIdentity,
} from "../../src/shared/usage-labels";

/**
 * The Usage table's API Key cell has two lines: the key label and the client.
 * Probe rows have neither, so before this helper both lines rendered "—" and the
 * row was unreadable. These assertions pin the classification, and — most
 * importantly — that a real client request carrying an API key is never
 * relabelled as a probe.
 */

/** A row shaped the way `mapUsageRequestItem` emits it. */
const ROW = (over: UsageKeyIdentity): UsageKeyIdentity => over;

const LIVE: UsageKeyIdentity = ROW({
  apiKeyId: "bdf610e7-ae71-4e4d-92b8-fec30aee0803",
  apiKeyLabel: "my-laptop",
  userAgent: "OpenAI/Python 2.24.0",
  clientName: "OpenAI/Python 2.24.0",
});

// Probe rows carry no key, no user agent and no client IP. This is exact
// against production: 11,723 keyed rows and 59 key-less rows, zero overlap.
const PROBE: UsageKeyIdentity = ROW({});

describe("isProbeRequest", () => {
  test("a request with an API key is never a probe", () => {
    expect(isProbeRequest(LIVE)).toBe(false);
  });

  test("a row with no API key is a probe", () => {
    expect(isProbeRequest(PROBE)).toBe(true);
  });

  test("a keyed row that still has a user agent is not a probe", () => {
    // Guards the key branch against being overridden by the client branch.
    expect(isProbeRequest({ apiKeyId: "abc", userAgent: "curl/8.0" })).toBe(false);
  });

  test("the legacy user-agent marker still classifies a probe", () => {
    // Forward-compatible: if probing-service ever sets this header.
    expect(isProbeRequest({ userAgent: "Cartethyia Probe" })).toBe(true);
  });

  test("a key-less row is a probe whatever user agent it carries", () => {
    // The user-agent check is only ever a positive signal; absence of a key is
    // what actually decides, so an unrelated UA must not flip the verdict.
    expect(isProbeRequest({ userAgent: "Cartethyia Probe v2" })).toBe(true);
  });

  test("missing row is not a probe", () => {
    expect(isProbeRequest(null)).toBe(false);
    expect(isProbeRequest(undefined)).toBe(false);
  });
});

describe("usageApiKeyLabel", () => {
  test("shows the key's label when there is one", () => {
    expect(usageApiKeyLabel(LIVE)).toBe("my-laptop");
  });

  test("labels a probe instead of leaving an em dash", () => {
    expect(usageApiKeyLabel(PROBE)).toBe("Probe");
  });

  test("falls back to a key prefix when the label is unresolved", () => {
    // apiKeyLabels() can miss (e.g. a deleted key) — the column must still
    // identify the row rather than render a bare dash.
    expect(usageApiKeyLabel({ apiKeyId: "bdf610e7-ae71-4e4d-92b8-fec30aee0803" })).toBe("bdf610e7…");
  });

  test("em dash only when there is genuinely nothing to show", () => {
    expect(usageApiKeyLabel(null)).toBe("—");
  });
});

describe("usageClientLabel", () => {
  test("shows the client name for a live request", () => {
    expect(usageClientLabel(LIVE)).toBe("OpenAI/Python 2.24.0");
  });

  test("falls back to the raw user agent", () => {
    expect(usageClientLabel({ apiKeyId: "abc", userAgent: "curl/8.0" })).toBe("curl/8.0");
  });

  test("names the probe instead of leaving an em dash", () => {
    expect(usageClientLabel(PROBE)).toBe("Provider test");
  });

  test("em dash for a keyed row with no client identity", () => {
    // A keyed row is real traffic, so it must NOT claim to be a provider test.
    expect(usageClientLabel({ apiKeyId: "abc" })).toBe("—");
  });

  test("em dash when the row is missing", () => {
    expect(usageClientLabel(null)).toBe("—");
  });
});
