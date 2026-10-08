/**
 * OpenCode Free rewrites the canonical request before it is encoded.
 *
 * `fledge-alpha-free` rejects any temperature outside {0, 0.6, 1} with a 400,
 * and clients send arbitrary values, so the adapter snaps an out-of-set value
 * to the nearest allowed one. A value already in the set must pass through
 * unchanged, and a model that is not restricted must not be touched.
 */
import { describe, expect, test } from "bun:test";
import { OPENCODE_FREE_SPEC } from "../../src/providers/specs/opencode";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function request(model: string, temperature: number | undefined): CanonicalRequest {
  return {
    model,
    messages: [],
    stream: true,
    tools: [],
    generation_controls: temperature === undefined ? {} : { temperature },
  } as unknown as CanonicalRequest;
}

const prepare = OPENCODE_FREE_SPEC.prepareRequest!;

describe("OpenCode Free restricted temperature", () => {
  test("snaps an out-of-set temperature to the nearest allowed value", () => {
    expect(prepare(request("opencodeft/fledge-alpha-free", 0.7)).generation_controls.temperature).toBe(0.6);
    expect(prepare(request("fledge-alpha-free", 0.2)).generation_controls.temperature).toBe(0);
    expect(prepare(request("fledge-alpha-free", 0.9)).generation_controls.temperature).toBe(1);
  });

  test("leaves an allowed temperature untouched", () => {
    for (const value of [0, 0.6, 1]) {
      expect(prepare(request("fledge-alpha-free", value)).generation_controls.temperature).toBe(value);
    }
  });

  test("does not touch a model that accepts any temperature", () => {
    const prepared = prepare(request("opencodeft/some-other-model", 0.7));
    expect(prepared.generation_controls.temperature).toBe(0.7);
  });

  test("does nothing when no temperature was sent", () => {
    const prepared = prepare(request("fledge-alpha-free", undefined));
    expect(prepared.generation_controls.temperature).toBeUndefined();
  });
});
