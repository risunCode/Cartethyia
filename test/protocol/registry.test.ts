import { describe, expect, test } from "bun:test";
import {
  decodeWireResponse,
  decodeWireStream,
  encodeWireRequest,
} from "../../src/protocol/registry";
import type { CanonicalRequest } from "../../src/transport/canonical-model";

describe("wire codec dispatch", () => {
  test("covers exactly the canonical wire families and rejects anything else", () => {
    // A bespoke adapter (Cursor, Devin) frames its own protocol and never
    // reaches these codecs, so there is no "native" family to dispatch. The
    // runtime guard still has to refuse an unknown value rather than fall
    // through to a wrong codec.
    const request = {} as CanonicalRequest;
    const unknown = "native" as unknown as Parameters<typeof encodeWireRequest>[0];
    expect(() => encodeWireRequest(unknown, request)).toThrow("unsupported wire family");
    expect(() => decodeWireResponse(unknown, {}, request)).toThrow("unsupported wire family");
    expect(() => decodeWireStream(unknown, new ReadableStream(), request)).toThrow("unsupported wire family");
  });

  test("exposes static dispatch functions", () => {
    expect(encodeWireRequest).toBeFunction();
    expect(decodeWireResponse).toBeFunction();
    expect(decodeWireStream).toBeFunction();
  });
});
