/**
 * Kimi credential parsing: the two persisted shapes, and why both are live.
 *
 * A Kimi OAuth account's secret is either the JSON envelope this gateway writes
 * (`{accessToken, deviceId}`) or a bare token with no envelope. The second shape
 * looks like legacy residue and is tempting to delete, so this file records the
 * measurement that keeps it: it is not only old data.
 *
 * The 9Router importer (`console/backup/nine-router.ts`) maps that router's
 * `kimi` provider onto ours and stores the credential **verbatim** — it takes
 * `apiKey ?? accessToken ?? credential ?? token` off the export row and
 * re-encrypts it without reshaping. A 9Router export holds a raw token, so an
 * import performed today produces exactly the bare shape. Deleting the fallback
 * would make every imported Kimi account unparseable, which is a fresh-install
 * regression, not a legacy-data one.
 *
 * The device id is the reason the fallback cannot simply return the token: Kimi
 * binds a device identity to the token, so a bare token still needs a stable id
 * derived from it. The tests below pin that it is deterministic — the same token
 * must always yield the same id, or a re-read would present a different device
 * than the one that minted the token.
 */
import { describe, expect, test } from "bun:test";
import { parseKimiCredential } from "../../src/providers/integrations/kimi/kimi-oauth";

/** The envelope this gateway writes when the device flow completes. */
function envelope(accessToken: string, deviceId: string): string {
  return JSON.stringify({ accessToken, deviceId });
}

describe("parseKimiCredential", () => {
  test("reads the envelope this gateway writes", () => {
    expect(parseKimiCredential(envelope("tok_abc", "device_1"))).toEqual({
      accessToken: "tok_abc",
      deviceId: "device_1",
    });
  });

  test("reads a bare token, which is what an import produces", () => {
    // The live path: 9Router stores a raw token and the importer preserves it.
    const parsed = parseKimiCredential("tok_raw");
    expect(parsed.accessToken).toBe("tok_raw");
    expect(parsed.deviceId.length).toBeGreaterThan(0);
  });

  test("a bare token gets a deterministic device id", () => {
    // The token must keep mapping to one device identity across reads: a new id
    // each time would present a different device than the one that minted it.
    expect(parseKimiCredential("tok_raw").deviceId).toBe(parseKimiCredential("tok_raw").deviceId);
  });

  test("different bare tokens get different device ids", () => {
    expect(parseKimiCredential("tok_a").deviceId).not.toBe(parseKimiCredential("tok_b").deviceId);
  });

  test("an envelope with a missing field falls back rather than half-parsing", () => {
    // `{accessToken}` with no deviceId is not a usable envelope. Falling back to
    // the bare path keeps the token and derives an id, instead of returning an
    // object with an empty deviceId that the provider would reject.
    const parsed = parseKimiCredential(JSON.stringify({ accessToken: "tok_abc" }));
    expect(parsed.accessToken.length).toBeGreaterThan(0);
    expect(parsed.deviceId.length).toBeGreaterThan(0);
  });

  test("a JSON string that is not an envelope is treated as a token", () => {
    // A token that happens to be valid JSON must not throw or parse to nothing.
    const parsed = parseKimiCredential('"tok_quoted"');
    expect(parsed.accessToken.length).toBeGreaterThan(0);
    expect(parsed.deviceId.length).toBeGreaterThan(0);
  });

  test("the token is trimmed, so a pasted newline does not reach the wire", () => {
    expect(parseKimiCredential("  tok_raw  ").accessToken).toBe("tok_raw");
  });

  test("an empty credential is rejected, not silently accepted", () => {
    // Fail closed: an empty secret must surface as an error at the parse, not
    // become an empty Authorization header on the wire.
    expect(() => parseKimiCredential("")).toThrow();
    expect(() => parseKimiCredential("   ")).toThrow();
  });
});
