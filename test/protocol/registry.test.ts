import { describe, expect, test } from "bun:test";
import {
  decodeWireResponse,
  decodeWireStream,
  encodeWireRequest,
} from "../../src/protocol/registry";
import type { CanonicalRequest } from "../../src/transport/canonical-model";

describe("wire codec dispatch", () => {
  test("rejects bespoke native wire families", () => {
    const request = {} as CanonicalRequest;
    expect(() => encodeWireRequest("native", request)).toThrow("unsupported wire family");
    expect(() => decodeWireResponse("native", {}, request)).toThrow("unsupported wire family");
    expect(() => decodeWireStream("native", new ReadableStream(), request)).toThrow("unsupported wire family");
  });

  test("exposes static dispatch functions", () => {
    expect(encodeWireRequest).toBeFunction();
    expect(decodeWireResponse).toBeFunction();
    expect(decodeWireStream).toBeFunction();
  });
});
