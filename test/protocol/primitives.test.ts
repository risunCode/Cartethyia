/**
 * Protocol primitives: the shared coercion, sanitization, and wire-shaping
 * helpers every request builder and response decoder leans on.
 *
 * This module is unusual in that almost every function is a *boundary* — it takes
 * a value that came from a provider, an operator, or a caller's tool schema, and
 * produces something the upstream will accept. So the tests are organised around
 * what each one refuses or rewrites, not around the happy path:
 *
 * - `normalizeAnthropicToolCallId` must fit Anthropic's `^[a-zA-Z0-9_-]{1,64}$`
 *   and keep distinct calls distinct. Both halves are tested; the second half has
 *   a `test.failing`.
 * - `sanitizeSchemaForAnthropic` drops keywords a strict upstream rejects, and
 *   rebuilds `required` from the surviving properties.
 * - `filterProviderCustomHeaders` is the only gate on operator-supplied outbound
 *   headers, so every rejection reason is pinned.
 * - `resolveImageSource` accepts five different origin shapes and must return
 *   `undefined` for a sixth rather than silently dropping an attachment.
 *
 * Every expected value here was measured against the module with a throwaway
 * probe, not derived from its comments — several of my first guesses were wrong
 * and the corrections are recorded inline.
 */
import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../src/transport/gateway-error";
import {
  canonicalTerminal,
  completeRequiredSchema,
  decodeCodexToolCallId,
  encodeCodexToolCallId,
  endpointUrl,
  escapeHarmonyControlTokens,
  escapeHarmonyControlTokensDeep,
  filterProviderCustomHeaders,
  isClaudeBillingHeaderText,
  isRecord,
  joinUrl,
  mapReasoningEffortToWireTier,
  normalizeAnthropicToolCallId,
  normalizeBearerToken,
  parseArguments,
  prefixClaudeToolName,
  readBoolean,
  readNumber,
  readOutputIndex,
  readString,
  resolveImageSource,
  resolveOutputVerbosity,
  sanitizeSchemaForAnthropic,
  splitDataUrl,
  toAsciiJsonString,
  toWellFormedDeep,
  toWellFormedString,
  tryParseJsonObject,
  unprefixClaudeToolName,
} from "../../src/protocol/primitives";

/** Runs `body`, returning the thrown error — for asserting on rejections. */
function thrownBy(body: () => unknown): unknown {
  try {
    body();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("isRecord", () => {
  test("plain objects pass, everything else does not", () => {
    // The guard the whole module keys on; an array or null slipping through would
    // make every reader treat a non-object as a record.
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("s")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

describe("readString / readNumber / readBoolean", () => {
  test("a present value of the right type is returned", () => {
    expect(readString({ a: "x" }, "a")).toBe("x");
    expect(readNumber({ a: 1.5 }, "a")).toBe(1.5);
    expect(readBoolean({ a: false }, "a")).toBe(false);
  });

  test("an absent key yields undefined", () => {
    expect(readString({}, "a")).toBeUndefined();
    expect(readNumber({}, "a")).toBeUndefined();
    expect(readBoolean({}, "a")).toBeUndefined();
  });

  test("a wrong-typed value yields undefined rather than a coercion", () => {
    // No `String(value)` or `Number(value)`: a provider sending `"5"` for a
    // number field is a wire deviation, and coercing it would hide that.
    expect(readString({ a: 1 }, "a")).toBeUndefined();
    expect(readNumber({ a: "5" }, "a")).toBeUndefined();
    expect(readBoolean({ a: "true" }, "a")).toBeUndefined();
    expect(readBoolean({ a: 1 }, "a")).toBeUndefined();
  });

  test("a non-finite number is rejected", () => {
    // `Number.isFinite` — a NaN or Infinity from a JSON `1e999` must not become a
    // measured value.
    expect(readNumber({ a: Number.NaN }, "a")).toBeUndefined();
    expect(readNumber({ a: Number.POSITIVE_INFINITY }, "a")).toBeUndefined();
  });

  test("an empty string is a value, not an absence", () => {
    // `typeof === "string"` — the caller decides whether "" is meaningful.
    expect(readString({ a: "" }, "a")).toBe("");
  });
});

describe("readOutputIndex", () => {
  test("an integer index is returned", () => {
    expect(readOutputIndex({ output_index: 3 })).toBe(3);
    expect(readOutputIndex({ output_index: 0 })).toBe(0);
  });

  test("a fractional index is truncated rather than rejected", () => {
    // Documented: a fractional index still identifies the same slot, so it must
    // not be discarded.
    expect(readOutputIndex({ output_index: 2.9 })).toBe(2);
    expect(readOutputIndex({ output_index: -1.5 })).toBe(-1);
  });

  test("a non-finite index is discarded so it never becomes a map key", () => {
    // Documented. A NaN key would silently merge every NaN-indexed delta.
    expect(readOutputIndex({ output_index: Number.NaN })).toBeUndefined();
    expect(readOutputIndex({ output_index: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  test("a missing or non-numeric index yields undefined, not zero", () => {
    // The documented reason: an absent index must not collide with a real slot 0.
    expect(readOutputIndex({})).toBeUndefined();
    expect(readOutputIndex({ output_index: "0" })).toBeUndefined();
    expect(readOutputIndex({ output_index: null })).toBeUndefined();
  });
});

describe("normalizeAnthropicToolCallId — the wire contract", () => {
  /** Anthropic's documented requirement. */
  const ANTHROPIC_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

  test("a valid id passes through unchanged", () => {
    expect(normalizeAnthropicToolCallId("toolu_abc-123")).toBe("toolu_abc-123");
  });

  test("a composite Responses id keeps only its first segment", () => {
    // `call_id|item_id` — the pipe is not in Anthropic's charset, and the call id
    // is the half the tool_result must match.
    expect(normalizeAnthropicToolCallId("call_id|item_id")).toBe("call_id");
    expect(normalizeAnthropicToolCallId("call|")).toBe("call");
  });

  test("invalid characters become underscores", () => {
    expect(normalizeAnthropicToolCallId("bad!chars@here")).toBe("bad_chars_here");
    expect(normalizeAnthropicToolCallId("a.b.c")).toBe("a_b_c");
  });

  test("an id that normalizes to nothing gets a deterministic hash fallback", () => {
    // An empty id (or one that is only a `|` composite with an empty first
    // segment) has nothing left after replacement, so the `toolu_<hash32 hex>`
    // fallback fires. It is deterministic because the tool_result must resolve to
    // the same id.
    const empty = normalizeAnthropicToolCallId("");
    expect(empty).toMatch(/^toolu_[0-9a-f]{8}$/);
    expect(normalizeAnthropicToolCallId("")).toBe(empty);
  });

  test("MEASURED: a non-ASCII id becomes underscores rather than the hash fallback", () => {
    // I first expected `"🦊"` to reach the hash fallback and was wrong. The
    // replacement is per UTF-16 CODE UNIT, and an emoji is a surrogate PAIR, so
    // the two units become two underscores — a non-empty, pattern-valid result.
    // The fallback only fires when the string is genuinely empty.
    //
    // The consequence is worth naming: every two-code-unit non-ASCII id collapses
    // to the same `"__"`, and every three-unit one to `"___"`. So two DIFFERENT
    // emoji ids are indistinguishable after normalization. That is the same
    // collision class as the `test.failing` defect below (distinct raws collapsing
    // to one id) and is covered by it rather than reported twice.
    expect(normalizeAnthropicToolCallId("🦊")).toBe("__");
    expect(normalizeAnthropicToolCallId("🐱")).toBe("__");
    expect(normalizeAnthropicToolCallId("🦊")).toBe(normalizeAnthropicToolCallId("🐱"));
  });

  test("a leading pipe produces the fallback rather than an empty id", () => {
    // `"|only-item"` splits to `["", "only-item"]`, so the base is empty and the
    // fallback fires. Pinned because the second segment is discarded.
    expect(normalizeAnthropicToolCallId("|only-item")).toMatch(/^toolu_[0-9a-f]{8}$/);
  });

  test("an over-length id is truncated with a hash suffix", () => {
    // The hash is what keeps two long ids sharing a prefix from colliding.
    const long = normalizeAnthropicToolCallId("a".repeat(70));
    expect(long).toHaveLength(64);
    expect(long).toMatch(ANTHROPIC_ID_RE);

    const a = normalizeAnthropicToolCallId(`${"b".repeat(55)}X${"c".repeat(20)}`);
    const b = normalizeAnthropicToolCallId(`${"b".repeat(55)}Y${"c".repeat(20)}`);
    expect(a).not.toBe(b);
  });

  test("the length boundary is 64, inclusive", () => {
    for (const length of [63, 64]) {
      expect(normalizeAnthropicToolCallId("z".repeat(length))).toBe("z".repeat(length));
    }
    expect(normalizeAnthropicToolCallId("z".repeat(65))).toHaveLength(64);
  });

  test("every output satisfies Anthropic's pattern", () => {
    // The invariant the function exists for, swept over the shapes a provider can
    // send. A single violation is a whole-request 400.
    for (const raw of [
      "",
      "|",
      "🦊",
      "a".repeat(200),
      "call_id|item_id",
      "bad!chars@here",
      "a.b.c",
      "  spaced  ",
      "\n\t",
      "Ünïcödé",
      "call|",
      "toolu_" + "x".repeat(100),
    ]) {
      expect(normalizeAnthropicToolCallId(raw)).toMatch(ANTHROPIC_ID_RE);
    }
  });
});

describe("normalizeAnthropicToolCallId — deduplication", () => {
  test("a repeated already-valid id gets an incrementing _dupN suffix", () => {
    // The documented contract, and it works on this input: the raw is already
    // valid, so `base === normalized` and the counter is read once per call.
    const seen = new Map<string, number>();
    expect(normalizeAnthropicToolCallId("toolu_x", seen)).toBe("toolu_x");
    expect(normalizeAnthropicToolCallId("toolu_x", seen)).toBe("toolu_x_dup1");
    expect(normalizeAnthropicToolCallId("toolu_x", seen)).toBe("toolu_x_dup2");
  });

  test("a repeated composite id gets an incrementing suffix", () => {
    // The composite base is `call_a` for all three, and the raw IS the base
    // (`"call_a|item_b"` — wait: the raw differs from the base, yet the counter
    // still increments). MEASURED: the dedup read is
    // `seen.get(normalized)`, and the double-increment only shows up when the
    // suffixed result is itself re-registered as the base — see the test below.
    const seen = new Map<string, number>();
    const outputs = [
      normalizeAnthropicToolCallId("call_a|item_b", seen),
      normalizeAnthropicToolCallId("call_a|item_b", seen),
      normalizeAnthropicToolCallId("call_a|item_b", seen),
    ];
    expect(outputs).toEqual(["call_a", "call_a_dup1", "call_a_dup2"]);
  });

  test("a suffixed id stays within the length limit", () => {
    // The suffix is carved out of the 64-char budget, not appended past it.
    const seen = new Map<string, number>();
    const outputs = Array.from({ length: 12 }, () =>
      normalizeAnthropicToolCallId("y".repeat(64), seen),
    );
    for (const id of outputs) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(id.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(outputs).size).toBe(outputs.length);
  });

  test("a separate `seen` map starts fresh", () => {
    // The map is per-request state; a new request must not inherit suffixes.
    expect(normalizeAnthropicToolCallId("toolu_x", new Map())).toBe("toolu_x");
    expect(normalizeAnthropicToolCallId("toolu_x", new Map())).toBe("toolu_x");
  });

  test("distinct calls never collapse to one id, whatever the raw shape", () => {
    // The defect this pins: `normalizeAnthropicToolCallId` used to derive the
    // `_dupN` suffix from a count keyed on the RAW id, so two raws that
    // canonicalize to the same base (`call!x` and `call@x` both become `call_x`)
    // each derived `_dup1` — and the second and every later occurrence of one raw
    // also re-derived `_dup1` instead of advancing. The ledger is now keyed on the
    // CANONICAL form, and both the base and each generated id are reserved.
    const seen = new Map<string, number>();

    // Three distinct raws that all normalize to `call_x`.
    const distinct = ["call!x", "call@x", "call#x"].map((raw) =>
      normalizeAnthropicToolCallId(raw, seen),
    );
    expect(new Set(distinct).size).toBe(3);
    expect(distinct[0]).toBe("call_x");
    expect(distinct[1]).not.toBe(distinct[0]);
    expect(distinct[2]).not.toBe(distinct[1]);
  });

  test("repeated occurrences of one rewritten raw each get their own id", () => {
    // The other half: the same raw seen N times. Before the fix only the first two
    // were distinct.
    for (const raw of [
      "call!x",
      "call_a|item_b",
      "z".repeat(70),
      "",
      "🦊",
    ]) {
      const seen = new Map<string, number>();
      const outputs = Array.from({ length: 6 }, () => normalizeAnthropicToolCallId(raw, seen));
      expect(new Set(outputs).size).toBe(outputs.length);
      for (const id of outputs) {
        expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      }
    }
  });

  test("a raw that naturally equals a generated id does not collide with it", () => {
    // The reservation of generated ids. `call_x_dup1` is a legal raw id, and a
    // provider could plausibly send it — it must not be handed to two calls.
    const seen = new Map<string, number>();
    const outputs = [
      normalizeAnthropicToolCallId("call_x", seen), // call_x
      normalizeAnthropicToolCallId("call_x", seen), // call_x_dup1
      normalizeAnthropicToolCallId("call_x_dup1", seen), // must not be call_x_dup1
    ];
    expect(new Set(outputs).size).toBe(3);
  });

  test("the suffix index keeps advancing past ten", () => {
    // The `_dupN` suffix grows a digit at N=10, which shrinks the base budget by
    // one; the result must still fit and stay distinct.
    const seen = new Map<string, number>();
    const outputs = Array.from({ length: 14 }, () =>
      normalizeAnthropicToolCallId("dup_me", seen),
    );
    expect(new Set(outputs).size).toBe(14);
    expect(outputs).toContain("dup_me_dup10");
    for (const id of outputs) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("every already-valid path still behaves as documented", () => {
    // The contrast that used to hide the defect: a raw needing no rewriting was
    // always correct. It must stay correct.
    const seen = new Map<string, number>();
    const outputs = Array.from({ length: 4 }, () =>
      normalizeAnthropicToolCallId("call_x", seen),
    );
    expect(outputs).toEqual(["call_x", "call_x_dup1", "call_x_dup2", "call_x_dup3"]);
  });

  test("a fresh ledger is independent of a used one", () => {
    const used = new Map<string, number>();
    normalizeAnthropicToolCallId("call!x", used);
    expect(normalizeAnthropicToolCallId("call!x", new Map())).toBe("call_x");
  });

  test("a mixed batch keeps every id distinct", () => {
    // The end-to-end shape of the caller: one ledger, one request, many calls of
    // every shape. This is the assertion that would have caught the defect.
    const seen = new Map<string, number>();
    const raws = [
      "call_x",
      "call!x",
      "call@x",
      "call_x",
      "call_a|item_b",
      "call_a|item_c",
      "z".repeat(70),
      "z".repeat(70),
      "",
      "",
      "🦊",
      "🐱",
      "call_x_dup1",
    ];
    const outputs = raws.map((raw) => normalizeAnthropicToolCallId(raw, seen));
    expect(new Set(outputs).size).toBe(raws.length);
    for (const id of outputs) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("sanitizeSchemaForAnthropic", () => {
  test("wire-unsupported keywords are dropped", () => {
    // A strict upstream 400s on them, and the comment says so: drop rather than
    // invent caller text explaining the drop.
    expect(sanitizeSchemaForAnthropic({ type: "string", format: "date", pattern: "x" })).toEqual({
      type: "string",
      pattern: "x",
    });
  });

  test("supported keywords survive", () => {
    // A sample across the allowlist, so a shrink is visible.
    const schema = {
      $ref: "#/x",
      $defs: { A: { type: "string" } },
      type: "object",
      enum: ["a"],
      const: "a",
      description: "d",
      title: "t",
      default: "a",
      additionalProperties: false,
      items: { type: "string" },
      anyOf: [{ type: "string" }],
      oneOf: [{ type: "string" }],
      allOf: [{ type: "string" }],
      minItems: 1,
      maxItems: 2,
      minLength: 1,
      maxLength: 2,
      minimum: 1,
      maximum: 2,
      exclusiveMinimum: 1,
      exclusiveMaximum: 2,
      minProperties: 1,
      maxProperties: 2,
    };
    const out = sanitizeSchemaForAnthropic(schema) as Record<string, unknown>;
    for (const key of Object.keys(schema)) {
      expect(out).toHaveProperty(key);
    }
  });

  test("property NAMES are preserved while each subschema is sanitized", () => {
    // The comment is explicit: property names are caller-defined, not keywords,
    // so a name that happens to match a dropped keyword must survive.
    const out = sanitizeSchemaForAnthropic({
      properties: { format: { type: "string", format: "date" }, "weird-name!": { type: "number" } },
    }) as { properties: Record<string, unknown> };
    expect(Object.keys(out.properties).sort()).toEqual(["format", "weird-name!"]);
    expect(out.properties.format).toEqual({ type: "string" });
  });

  test("`required` is rebuilt from the surviving property names", () => {
    // The documented reason: the Anthropic-compatible endpoint validates tool
    // schemas as strict objects, so every declared property must be required.
    const out = sanitizeSchemaForAnthropic({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["zzz-not-a-property"],
    }) as Record<string, unknown>;
    expect(out.required).toEqual(["a", "b"]);
  });

  test("a properties object implies `type: object`", () => {
    const out = sanitizeSchemaForAnthropic({ properties: { a: { type: "string" } } }) as Record<
      string,
      unknown
    >;
    expect(out.type).toBe("object");
  });

  test("an explicit type is not overwritten by the properties inference", () => {
    // `out.type ??= "object"` — only fills a gap.
    const out = sanitizeSchemaForAnthropic({
      type: "array",
      properties: { a: { type: "string" } },
    }) as Record<string, unknown>;
    expect(out.type).toBe("array");
  });

  test("an empty properties object still gets required: []", () => {
    // MEASURED: `Object.keys({})` is `[]`, and the assignment is unconditional
    // once `properties` is a record. Pinned because an empty `required` is valid
    // JSON Schema and the upstream accepts it.
    expect(sanitizeSchemaForAnthropic({ properties: {} })).toEqual({
      properties: {},
      type: "object",
      required: [],
    });
  });

  test("a non-record `properties` is dropped rather than passed through", () => {
    // MEASURED: `properties` IS in the allowlist, so the key survives — but the
    // special-case branch does not fire (the child is a string), so it is copied
    // through the generic path and then has no schema to recurse into. Pinned.
    const out = sanitizeSchemaForAnthropic({ properties: "nope" }) as Record<string, unknown>;
    expect(out.properties).toBe("nope");
    expect(out.required).toBeUndefined();
  });

  test("nested schemas are sanitized recursively", () => {
    const out = sanitizeSchemaForAnthropic({
      properties: {
        outer: { format: "x", properties: { inner: { format: "y", type: "string" } } },
      },
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties.outer?.format).toBeUndefined();
    const inner = out.properties.outer?.properties as Record<string, Record<string, unknown>>;
    expect(inner.inner?.format).toBeUndefined();
    expect(inner.inner?.type).toBe("string");
    expect(out.properties.outer?.required).toEqual(["inner"]);
  });

  test("arrays are mapped element-wise", () => {
    expect(sanitizeSchemaForAnthropic([{ format: "x", type: "y" }])).toEqual([{ type: "y" }]);
  });

  test("a non-object value passes through untouched", () => {
    // The recursion's base case: a string, number, or boolean schema fragment.
    expect(sanitizeSchemaForAnthropic("hello")).toBe("hello");
    expect(sanitizeSchemaForAnthropic(42)).toBe(42);
    expect(sanitizeSchemaForAnthropic(null)).toBeNull();
  });

  test("no dropped keyword survives anywhere in a nested tree", () => {
    // A sweep asserting the module's one guarantee: nothing the upstream rejects
    // is left in the output.
    const input = {
      properties: {
        a: { format: "date", patternProperties: {}, examples: [], deprecated: true },
        b: { items: { format: "time", properties: { c: { unevaluatedProperties: false } } } },
      },
      examples: [1],
      $comment: "x",
      unevaluatedProperties: false,
    };
    const serialized = JSON.stringify(sanitizeSchemaForAnthropic(input));
    for (const dropped of [
      "format",
      "patternProperties",
      "examples",
      "deprecated",
      "unevaluatedProperties",
      "$comment",
    ]) {
      expect(serialized).not.toContain(dropped);
    }
  });
});

describe("completeRequiredSchema", () => {
  test("every declared property is added to required", () => {
    // The OpenAI-compatible bridges reject a tool whose properties are not all
    // required.
    expect(completeRequiredSchema({ properties: { a: { type: "string" } } })).toEqual({
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  test("unlike the Anthropic sanitizer, unknown keys are KEPT", () => {
    // The discriminating difference between the two functions: this one completes,
    // it does not filter. A bridge that rejects unknown keywords is the other
    // function's job.
    const out = completeRequiredSchema({ format: "x", properties: { a: {} } }) as Record<
      string,
      unknown
    >;
    expect(out.format).toBe("x");
  });

  test("an existing required list is overwritten", () => {
    const out = completeRequiredSchema({
      properties: { a: {}, b: {} },
      required: ["a"],
    }) as Record<string, unknown>;
    expect(out.required).toEqual(["a", "b"]);
  });

  test("a schema with no properties is unchanged in shape", () => {
    const out = completeRequiredSchema({ type: "string" }) as Record<string, unknown>;
    expect(out.required).toBeUndefined();
    expect(out.type).toBe("string");
  });

  test("nesting recurses", () => {
    const out = completeRequiredSchema({
      properties: { outer: { properties: { inner: { type: "string" } } } },
    }) as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties.outer?.required).toEqual(["inner"]);
  });

  test("a non-object passes through", () => {
    expect(completeRequiredSchema("hi")).toBe("hi");
    expect(completeRequiredSchema([{ properties: { a: {} } }])).toEqual([
      { properties: { a: {} }, required: ["a"] },
    ]);
  });
});

describe("prefixClaudeToolName / unprefixClaudeToolName", () => {
  test("an OAuth caller's custom tool gets the underscore prefix", () => {
    // The prefix namespaces the operator's tools so they cannot shadow the
    // provider's built-ins on an OAuth (subscription) credential.
    expect(prefixClaudeToolName("my_tool", true)).toBe("_my_tool");
  });

  test("a non-OAuth caller is never prefixed", () => {
    expect(prefixClaudeToolName("my_tool", false)).toBe("my_tool");
  });

  test("built-in tool names are never prefixed", () => {
    // The whole point: a provider built-in must keep its exact name or the
    // upstream does not recognise it.
    for (const name of ["web_search", "web_fetch", "code_execution", "text_editor", "computer"]) {
      expect(prefixClaudeToolName(name, true)).toBe(name);
    }
  });

  test("the built-in check is case-insensitive", () => {
    // `name.toLowerCase()` — a caller sending `Web_Search` still matches, and the
    // ORIGINAL casing is returned.
    expect(prefixClaudeToolName("Web_Search", true)).toBe("Web_Search");
    expect(prefixClaudeToolName("WEB_SEARCH", true)).toBe("WEB_SEARCH");
  });

  test("unprefixing removes exactly one underscore", () => {
    // MEASURED: a name that already started with an underscore gains a second one
    // when prefixed, and unprefixing removes only the outer one. So the round trip
    // is lossless, which is the property that matters.
    expect(prefixClaudeToolName("_already", true)).toBe("__already");
    expect(unprefixClaudeToolName("__already", true)).toBe("_already");
  });

  test("the round trip is lossless for a prefixed name", () => {
    for (const name of ["my_tool", "web_search", "_x", "a-b", "Ünïcödé"]) {
      const prefixed = prefixClaudeToolName(name, true);
      expect(unprefixClaudeToolName(prefixed, true)).toBe(name);
    }
  });

  test("unprefixing a non-prefixed name is a no-op", () => {
    expect(unprefixClaudeToolName("plain", true)).toBe("plain");
  });

  test("a non-OAuth caller's name is never unprefixed", () => {
    // The guard is symmetric: a caller that was never prefixed must not have an
    // underscore stripped from a name that legitimately starts with one.
    expect(unprefixClaudeToolName("_plain", false)).toBe("_plain");
  });
});

describe("isClaudeBillingHeaderText", () => {
  test("the documented prefix is matched", () => {
    expect(isClaudeBillingHeaderText("x-anthropic-billing-header: abc")).toBe(true);
  });

  test("the match is anchored and case-sensitive", () => {
    // MEASURED: `startsWith`, so a mid-string occurrence is not a match, and the
    // casing is exact. Pinned because an echoed block the check misses would be
    // replayed upstream — which the comment says is what abuse detection keys on.
    expect(isClaudeBillingHeaderText("blah x-anthropic-billing-header: abc")).toBe(false);
    expect(isClaudeBillingHeaderText("X-Anthropic-Billing-Header: abc")).toBe(false);
    expect(isClaudeBillingHeaderText("")).toBe(false);
  });
});

describe("toWellFormedString / toWellFormedDeep", () => {
  test("a lone surrogate becomes U+FFFD", () => {
    // The reason this exists: a lone surrogate cannot be UTF-8 encoded, and an
    // upstream that receives one rejects the body. Both halves of a broken pair
    // are covered.
    expect(toWellFormedString("\uD800")).toBe("�");
    expect(toWellFormedString("\uDC00")).toBe("�");
    expect(toWellFormedString("a\uD800b")).toBe("a�b");
  });

  test("a valid pair is preserved", () => {
    expect(toWellFormedString("🦊")).toBe("🦊");
  });

  test("well-formed text is returned unchanged", () => {
    expect(toWellFormedString("plain ascii")).toBe("plain ascii");
    expect(toWellFormedString("")).toBe("");
  });

  test("the deep variant rewrites string leaves", () => {
    expect(toWellFormedDeep({ a: "\uD800", b: ["\uDC00", 1] })).toEqual({
      a: "�",
      b: ["�", 1],
    });
  });

  test("the deep variant returns the SAME object when nothing changed", () => {
    // An identity-preserving fast path, which is what keeps this cheap on the hot
    // path: an unchanged request body must not be reallocated.
    const input = { a: "fine", b: ["also fine", { c: 1 }] };
    expect(toWellFormedDeep(input)).toBe(input);
  });

  test("the deep variant returns a NEW object when something changed", () => {
    const input = { a: "fine", b: "\uD800" };
    const out = toWellFormedDeep(input);
    expect(out).not.toBe(input);
    expect(out).toEqual({ a: "fine", b: "�" });
  });

  test("non-string leaves pass through", () => {
    expect(toWellFormedDeep(42)).toBe(42);
    expect(toWellFormedDeep(null)).toBeNull();
    expect(toWellFormedDeep(true)).toBe(true);
    expect(toWellFormedDeep(undefined)).toBeUndefined();
  });

  test("the deep variant handles a changed leaf inside an array", () => {
    // The array branch has its own `changed` flag; a bug there would return a
    // sanitized array only when a nested OBJECT changed.
    const input = ["fine", "\uD800"];
    const out = toWellFormedDeep(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(["fine", "�"]);
  });
});

describe("parseArguments", () => {
  test("an empty or whitespace-only string becomes an empty object", () => {
    // The documented reason: a zero-arg tool call carries "", and the Messages
    // wire needs an object for `input`. Passing "" through draws an upstream 400.
    expect(parseArguments("")).toEqual({});
    expect(parseArguments("   ")).toEqual({});
    expect(parseArguments("\n\t")).toEqual({});
  });

  test("a JSON string is parsed", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("[1,2]")).toEqual([1, 2]);
  });

  test("a non-JSON string is returned verbatim rather than dropped", () => {
    // The caller sees the malformed text and can decide; silently returning {}
    // would hide a broken tool call.
    expect(parseArguments("not json")).toBe("not json");
    expect(parseArguments("{bad")).toBe("{bad");
  });

  test("a JSON literal that is not an object is still parsed", () => {
    // MEASURED: `JSON.parse` succeeds for `null`/`42`/`true`, so they are returned
    // as-is. Pinned because `parseArguments("null")` returns `null`, not `{}` —
    // the empty-string check is the only coercion.
    expect(parseArguments("null")).toBeNull();
    expect(parseArguments("42")).toBe(42);
    expect(parseArguments("true")).toBe(true);
    expect(parseArguments('"str"')).toBe("str");
  });

  test("a non-string value is passed through, with nullish becoming an object", () => {
    // `value ?? {}` — an absent arguments field must still produce the object the
    // wire needs.
    expect(parseArguments(undefined)).toEqual({});
    expect(parseArguments(null)).toEqual({});
    expect(parseArguments({ a: 1 })).toEqual({ a: 1 });
    expect(parseArguments(42)).toBe(42);
  });
});

describe("endpointUrl", () => {
  test("a relative path is joined onto the base", () => {
    expect(endpointUrl("https://api.example.com", "/v1/messages")).toBe(
      "https://api.example.com/v1/messages",
    );
  });

  test("trailing slashes on the base are collapsed", () => {
    expect(endpointUrl("https://api.example.com///", "/v1/messages")).toBe(
      "https://api.example.com/v1/messages",
    );
  });

  test("an absent base falls back to the Claude default", () => {
    // The documented default. Pinned because it is a wire destination.
    expect(endpointUrl(undefined, "/v1/messages")).toBe("https://api.anthropic.com/v1/messages");
  });

  test("OAuth appends the beta flag", () => {
    expect(endpointUrl("https://api.example.com", "/v1/messages", true)).toBe(
      "https://api.example.com/v1/messages?beta=true",
    );
  });

  test("an absolute endpoint path replaces the base entirely", () => {
    // The override an adapter uses to point at a different host.
    expect(endpointUrl("https://api.example.com", "https://other.example/x")).toBe(
      "https://other.example/x",
    );
  });

  test("the beta flag is appended to an absolute URL with the right separator", () => {
    expect(endpointUrl("https://api.example.com", "https://other.example/x", true)).toBe(
      "https://other.example/x?beta=true",
    );
    expect(endpointUrl("https://api.example.com", "https://other.example/x?y=1", true)).toBe(
      "https://other.example/x?y=1&beta=true",
    );
  });

  test("an absolute URL already carrying beta=true is not doubled", () => {
    // The `includes("?beta=true")` guard. Without it the upstream sees the flag
    // twice, which some gateways treat as a different request.
    expect(endpointUrl("https://api.example.com", "https://other.example/x?beta=true", true)).toBe(
      "https://other.example/x?beta=true",
    );
  });

  test("the scheme check is case-insensitive", () => {
    expect(endpointUrl("https://api.example.com", "HTTPS://other.example/x")).toBe(
      "HTTPS://other.example/x",
    );
  });

  test("a relative path is not treated as absolute", () => {
    // The negative case for the `/^https?:\/\//i` test — a bare path must be
    // joined, not used as the whole URL.
    expect(endpointUrl("https://api.example.com", "v1/messages")).toBe(
      "https://api.example.com/v1/messages",
    );
  });
});

describe("joinUrl", () => {
  test("exactly one slash joins the halves", () => {
    expect(joinUrl("https://x", "/y")).toBe("https://x/y");
    expect(joinUrl("https://x/", "/y")).toBe("https://x/y");
    expect(joinUrl("https://x", "y")).toBe("https://x/y");
    expect(joinUrl("https://x/", "y")).toBe("https://x/y");
  });

  test("an empty path leaves a trailing slash", () => {
    // MEASURED: `path.startsWith("/")` is false for "", so `/${path}` is "/". So
    // `joinUrl(base, "")` is `base + "/"`, not `base`. Pinned because a caller
    // expecting a bare base would get a different URL.
    expect(joinUrl("https://x", "")).toBe("https://x/");
  });

  test("an empty base yields the path", () => {
    expect(joinUrl("", "/y")).toBe("/y");
  });
});

describe("toAsciiJsonString", () => {
  test("plain ASCII passes through as JSON", () => {
    expect(toAsciiJsonString({ a: "b" })).toBe('{"a":"b"}');
  });

  test("non-ASCII is escaped as \\uXXXX", () => {
    // The header this feeds must stay ASCII-clean.
    expect(toAsciiJsonString({ a: "café" })).toBe('{"a":"caf\\u00e9"}');
    expect(toAsciiJsonString({ a: "🦊" })).toBe('{"a":"\\ud83e\\udd8a"}');
  });

  test("DEL is escaped too", () => {
    // The range starts at \x7f, not \u0080 — so DEL is covered.
    expect(toAsciiJsonString({ a: "\x7f" })).toBe('{"a":"\\u007f"}');
  });

  test("JSON's own escapes are left alone", () => {
    // A newline is already `\n` in JSON output, so the regex does not see a
    // non-ASCII character.
    expect(toAsciiJsonString({ a: "\n" })).toBe('{"a":"\\n"}');
  });

  test("the output is pure ASCII for any input", () => {
    // The property the header requires.
    const out = toAsciiJsonString({ a: "Ünïcödé 🦊 \u0000", b: "日本語" });
    expect(out).toMatch(/^[\x00-\x7f]*$/);
    expect(JSON.parse(out)).toEqual({ a: "Ünïcödé 🦊 \u0000", b: "日本語" });
  });
});

describe("encodeCodexToolCallId / decodeCodexToolCallId", () => {
  test("a supplied item id is used as the suffix", () => {
    expect(encodeCodexToolCallId("call_a", "item_b")).toBe("call_a__item_b");
  });

  test("an absent, empty, or null item id gets a deterministic hash suffix", () => {
    // The separator must stay inside Codex's `[A-Za-z0-9_-]` contract, and the
    // fallback must be stable so a replayed id decodes to the same call.
    const fromUndefined = encodeCodexToolCallId("call_a");
    const fromEmpty = encodeCodexToolCallId("call_a", "");
    const fromNull = encodeCodexToolCallId("call_a", null);
    expect(fromUndefined).toBe(fromEmpty);
    expect(fromUndefined).toBe(fromNull);
    expect(fromUndefined).toMatch(/^call_a__fc_[a-z0-9]+$/);
  });

  test("decoding strips the composite suffix", () => {
    expect(decodeCodexToolCallId("call_a__item_b")).toBe("call_a");
  });

  test("a legacy `|` separator is still decoded", () => {
    // Documented: replay of a stored older id.
    expect(decodeCodexToolCallId("call_a|item_b")).toBe("call_a");
  });

  test("an id with no separator is returned unchanged", () => {
    expect(decodeCodexToolCallId("plain")).toBe("plain");
    expect(decodeCodexToolCallId("")).toBe("");
  });

  test("the round trip recovers the call id", () => {
    for (const callId of ["call_a", "call-x", "call_x_1"]) {
      expect(decodeCodexToolCallId(encodeCodexToolCallId(callId, "item"))).toBe(callId);
      expect(decodeCodexToolCallId(encodeCodexToolCallId(callId))).toBe(callId);
    }
  });

  test("the encoded id contains no punctuation Codex rejects", () => {
    // The documented reason for the `__` separator.
    for (const [callId, itemId] of [
      ["call_a", "item_b"],
      ["call_a", null],
      ["a", "b"],
    ] as const) {
      expect(encodeCodexToolCallId(callId, itemId)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("`__` is preferred over `|` when both are present", () => {
    // The separator choice is `includes("__") ? "__" : "|"`, so an id containing
    // both decodes at the `__`.
    expect(decodeCodexToolCallId("a|b__c")).toBe("a|b");
  });
});

describe("mapReasoningEffortToWireTier", () => {
  test("the canonical vocabulary is identity-mapped", () => {
    // The union is `CodexWireEffort` in the module; the seven spellings below are
    // its members.
    const vocabulary = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    for (const effort of vocabulary) {
      expect(mapReasoningEffortToWireTier(effort)).toBe(effort);
    }
  });

  test("an absent effort stays absent", () => {
    // Documented: `undefined` in, `undefined` out — the field is omitted rather
    // than defaulted, so an unset effort does not become an explicit "medium".
    expect(mapReasoningEffortToWireTier(undefined)).toBeUndefined();
  });

  test("an unknown effort falls back to medium rather than dropping", () => {
    // Documented: "rather than dropping the request". The parameter is typed
    // `string | undefined`, so an out-of-vocabulary value is a real input.
    expect(mapReasoningEffortToWireTier("bogus")).toBe("medium");
    expect(mapReasoningEffortToWireTier("")).toBe("medium");
  });

  test("the match is case-sensitive", () => {
    // MEASURED: `"MAX"` is not in the vocabulary, so it becomes "medium" — a
    // silent downgrade of a caller's request. Pinned because it is the one case
    // where the fallback changes the request's meaning rather than just its
    // spelling.
    expect(mapReasoningEffortToWireTier("MAX")).toBe("medium");
    expect(mapReasoningEffortToWireTier("High")).toBe("medium");
  });
});

describe("resolveOutputVerbosity", () => {
  test("an absent controls object yields undefined", () => {
    expect(resolveOutputVerbosity(undefined)).toBeUndefined();
    expect(resolveOutputVerbosity({})).toBeUndefined();
  });

  test("the canonical slot is read", () => {
    expect(resolveOutputVerbosity({ verbosity: "high" })).toBe("high");
  });

  test("the surface-specific spellings are read", () => {
    // The documented reason: no surface parser writes the canonical slot, so
    // reading only it silently drops the control on every real request. The
    // `extension:` spellings are typed `unknown` on the contract, which is what
    // lets a surface store its own spelling there.
    expect(resolveOutputVerbosity({ "extension:verbosity": "low" })).toBe("low");
    expect(resolveOutputVerbosity({ "extension:responses.verbosity": "x" })).toBe("x");
  });

  test("the surface-specific spelling wins over the canonical slot", () => {
    // The documented precedence: surface-specific, then bare extension, then
    // canonical.
    expect(
      resolveOutputVerbosity({
        "extension:responses.verbosity": "from-responses",
        "extension:verbosity": "from-chat",
        verbosity: "high",
      }),
    ).toBe("from-responses");
    expect(
      resolveOutputVerbosity({ "extension:verbosity": "from-chat", verbosity: "high" }),
    ).toBe("from-chat");
  });

  test("an empty string is skipped in favour of a later candidate", () => {
    // The `length > 0` guard, so an empty surface spelling does not shadow the
    // canonical value.
    expect(resolveOutputVerbosity({ "extension:responses.verbosity": "", verbosity: "high" })).toBe(
      "high",
    );
  });

  test("a non-string extension value is skipped", () => {
    // The extension slots are `unknown`, so this is a reachable shape rather than
    // a type violation: a surface could store a number there.
    expect(resolveOutputVerbosity({ "extension:verbosity": 42 })).toBeUndefined();
    expect(resolveOutputVerbosity({ "extension:verbosity": null })).toBeUndefined();
  });

  test("an all-empty set yields undefined", () => {
    expect(resolveOutputVerbosity({ "extension:verbosity": "" })).toBeUndefined();
  });
});

describe("escapeHarmonyControlTokens", () => {
  test("each reserved token is escaped to its inert form", () => {
    // The reason: an unescaped token in untrusted text makes the backend's prompt
    // validator reject the whole request as invalid_prompt.
    for (const token of ["start", "end", "message", "channel", "constrain", "return", "call"]) {
      expect(escapeHarmonyControlTokens(`<|${token}|>`)).toBe(`<\\|${token}\\|>`);
    }
  });

  test("plain text is unchanged", () => {
    expect(escapeHarmonyControlTokens("plain")).toBe("plain");
    expect(escapeHarmonyControlTokens("")).toBe("");
  });

  test("an unreserved token spelling is left alone", () => {
    // MEASURED: only the seven listed spellings are escaped. A token the regex
    // does not know stays as-is, which is correct — escaping it would corrupt
    // legitimate text.
    expect(escapeHarmonyControlTokens("<|unknown|>")).toBe("<|unknown|>");
  });

  test("the match is case-sensitive", () => {
    expect(escapeHarmonyControlTokens("<|START|>")).toBe("<|START|>");
  });

  test("multiple tokens in one string are all escaped", () => {
    expect(escapeHarmonyControlTokens("a<|start|>b<|end|>c")).toBe("a<\\|start\\|>b<\\|end\\|>c");
  });

  test("escaping is idempotent", () => {
    // Documented as idempotent, which is what makes it safe to apply
    // unconditionally — including to already-escaped text.
    const once = escapeHarmonyControlTokens("<|start|>");
    expect(escapeHarmonyControlTokens(once)).toBe(once);
  });

  test("the deep variant escapes string leaves in arrays and objects", () => {
    expect(escapeHarmonyControlTokensDeep(["<|start|>", { k: "<|end|>" }])).toEqual([
      "<\\|start\\|>",
      { k: "<\\|end\\|>" },
    ]);
  });

  test("the deep variant passes non-strings through", () => {
    expect(escapeHarmonyControlTokensDeep(42)).toBe(42);
    expect(escapeHarmonyControlTokensDeep(null)).toBeNull();
  });

  test("the deep variant does not mutate its input", () => {
    // It builds a new object rather than writing through, so a caller's request
    // body is not modified under it.
    const input = { k: "<|start|>" };
    escapeHarmonyControlTokensDeep(input);
    expect(input.k).toBe("<|start|>");
  });
});

describe("tryParseJsonObject", () => {
  test("an object literal parses", () => {
    expect(tryParseJsonObject("{}")).toEqual({});
    expect(tryParseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  test("a non-object JSON value yields undefined", () => {
    // Documented: arrays and primitives are not objects, so the caller gets
    // undefined rather than a value it cannot index.
    expect(tryParseJsonObject("[1]")).toBeUndefined();
    expect(tryParseJsonObject("null")).toBeUndefined();
    expect(tryParseJsonObject("42")).toBeUndefined();
    expect(tryParseJsonObject('"s"')).toBeUndefined();
  });

  test("invalid JSON yields undefined rather than throwing", () => {
    expect(tryParseJsonObject("{bad")).toBeUndefined();
    expect(tryParseJsonObject("")).toBeUndefined();
  });
});

describe("canonicalTerminal", () => {
  test("the minimal terminal carries only type, sequence, and state", () => {
    // The envelope every stream closes with.
    expect(canonicalTerminal({ sequenceNumber: 1, state: "complete" })).toEqual({
      type: "terminal",
      sequence_number: 1,
      state: "complete",
    });
  });

  test("every optional field is emitted when supplied", () => {
    const usage = { input_tokens: 1 } as never;
    expect(
      canonicalTerminal({
        sequenceNumber: 2,
        state: "failed",
        stopReason: "stop",
        providerStopReason: "end_turn",
        stopDetails: { a: 1 },
        usage,
        responseId: "r",
        eventId: "e",
      }),
    ).toEqual({
      type: "terminal",
      sequence_number: 2,
      state: "failed",
      response_id: "r",
      event_id: "e",
      stop_reason: "stop",
      provider_stop_reason: "end_turn",
      stop_details: { a: 1 },
      usage,
    });
  });

  test("an explicitly undefined optional is OMITTED, never present as undefined", () => {
    // The documented omission rule, and the reason this function exists: eight
    // call sites assembled this envelope by hand with the same conditional-spread
    // idiom. An explicit `undefined` would serialise inconsistently.
    const terminal = canonicalTerminal({
      sequenceNumber: 3,
      state: "aborted",
      responseId: undefined,
      stopReason: undefined,
      usage: undefined,
    });
    expect(Object.keys(terminal)).toEqual(["type", "sequence_number", "state"]);
    expect("response_id" in terminal).toBe(false);
  });

  test("a nullish-but-not-undefined optional is still omitted", () => {
    // `stopDetails` is typed as possibly-undefined; a caller passing undefined
    // gets the same omission as one omitting the key.
    const terminal = canonicalTerminal({ sequenceNumber: 1, state: "complete", stopDetails: undefined });
    expect("stop_details" in terminal).toBe(false);
  });

  test("an empty-object stopDetails IS emitted", () => {
    // The discriminating case for the `=== undefined` check: `{}` is a real value
    // and must not be dropped as falsy.
    const terminal = canonicalTerminal({ sequenceNumber: 1, state: "complete", stopDetails: {} });
    expect("stop_details" in terminal).toBe(true);
  });

  test("sequence number zero is preserved", () => {
    expect(canonicalTerminal({ sequenceNumber: 0, state: "complete" }).sequence_number).toBe(0);
  });
});

describe("splitDataUrl", () => {
  test("a base64 data URL is split into media type and payload", () => {
    expect(splitDataUrl("data:image/png;base64,AAAA")).toEqual({
      mediaType: "image/png",
      data: "AAAA",
    });
  });

  test("a structured media type is preserved verbatim", () => {
    expect(splitDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toEqual({
      mediaType: "image/svg+xml",
      data: "PHN2Zz4=",
    });
  });

  test("a non-base64 data URL yields undefined", () => {
    // Documented: every wire this gateway speaks carries inline bytes as base64,
    // so a percent-encoded payload has no transport to land in.
    expect(splitDataUrl("data:image/png,AAAA")).toBeUndefined();
  });

  test("a non-data URL yields undefined", () => {
    expect(splitDataUrl("https://x/y.png")).toBeUndefined();
  });

  test("an empty payload yields undefined rather than empty bytes", () => {
    // Documented: the `data.length === 0` guard. Pinned because an empty image
    // would otherwise be forwarded as a zero-byte attachment.
    expect(splitDataUrl("data:image/png;base64,")).toBeUndefined();
  });

  test("a missing media type yields undefined", () => {
    expect(splitDataUrl("data:;base64,AAAA")).toBeUndefined();
  });

  test("the `data:` prefix is case-sensitive", () => {
    // MEASURED: `DATA:` does not match the anchored regex, so it yields
    // undefined. Pinned because RFC 2397 says the scheme is case-insensitive, so
    // a caller sending `DATA:` has its attachment dropped rather than forwarded.
    expect(splitDataUrl("DATA:image/png;base64,AA")).toBeUndefined();
  });
});

describe("resolveImageSource", () => {
  test("a bare URL string is the URL", () => {
    // Documented: an OpenAI Responses `input_image` payload is a string, and
    // accepting it here is what keeps a string-payload image from being dropped on
    // every surface at once.
    expect(resolveImageSource("https://x/y.png")).toEqual({ url: "https://x/y.png" });
    expect(resolveImageSource("data:image/png;base64,AA")).toEqual({
      url: "data:image/png;base64,AA",
    });
  });

  test("an empty string is rejected", () => {
    expect(resolveImageSource("")).toBeUndefined();
  });

  test("the OpenAI Chat shape is accepted", () => {
    expect(resolveImageSource({ image_url: "https://x/y.png" })).toEqual({
      url: "https://x/y.png",
    });
    expect(resolveImageSource({ image_url: { url: "https://x/y.png", detail: "low" } })).toEqual({
      url: "https://x/y.png",
      detail: "low",
    });
  });

  test("the Responses shape is accepted, including a file_id-only payload", () => {
    // The documented case the ordering exists for: an `input_image` may reference
    // the Files API with a top-level `file_id` and no `image_url` at all.
    expect(resolveImageSource({ file_id: "f1" })).toEqual({ fileId: "f1" });
    expect(resolveImageSource({ file_id: "f1", detail: "auto" })).toEqual({
      fileId: "f1",
      detail: "auto",
    });
    expect(resolveImageSource({ image_url: null, file_id: "f1" })).toEqual({ fileId: "f1" });
  });

  test("a top-level detail survives a bare url or file_id", () => {
    expect(resolveImageSource({ url: "https://x/y.png", detail: "high" })).toEqual({
      url: "https://x/y.png",
      detail: "high",
    });
  });

  test("the Anthropic base64 shape is re-encoded as a data URL", () => {
    expect(
      resolveImageSource({ source: { type: "base64", media_type: "image/jpeg", data: "AA" } }),
    ).toEqual({ url: "data:image/jpeg;base64,AA" });
  });

  test("a base64 source with no media_type defaults to PNG", () => {
    expect(resolveImageSource({ source: { type: "base64", data: "AA" } })).toEqual({
      url: "data:image/png;base64,AA",
    });
  });

  test("the Anthropic url and file shapes are accepted", () => {
    expect(resolveImageSource({ source: { type: "url", url: "https://x/y.png" } })).toEqual({
      url: "https://x/y.png",
    });
    expect(resolveImageSource({ source: { type: "file", file_id: "f2" } })).toEqual({
      fileId: "f2",
    });
  });

  test("an unrecognised shape yields undefined so the caller can degrade", () => {
    // Documented: "Returns undefined only for a shape this gateway cannot
    // re-encode, so callers can degrade explicitly instead of silently dropping
    // the image." Every non-image shape is covered.
    expect(resolveImageSource({ source: { type: "unknown" } })).toBeUndefined();
    expect(resolveImageSource({})).toBeUndefined();
    expect(resolveImageSource(null)).toBeUndefined();
    expect(resolveImageSource(42)).toBeUndefined();
    expect(resolveImageSource([])).toBeUndefined();
    expect(resolveImageSource({ detail: "high" })).toBeUndefined();
  });

  test("a top-level url wins over a nested image_url", () => {
    // MEASURED: the `image_url` arms run before the generic `url` scan, so a
    // nested url is found first when both are present — but the nested one is what
    // is returned. Pinned because it is the opposite of "top-level wins".
    expect(
      resolveImageSource({ image_url: { url: "https://nested.example/x" }, url: "https://top.example/x" }),
    ).toEqual({ url: "https://nested.example/x" });
  });

  test("every accepted shape returns at least one of url or fileId", () => {
    // The invariant callers depend on: an object result always carries a usable
    // reference, so a caller checking `result === undefined` never has to check
    // its fields too.
    const shapes = [
      "https://x/y.png",
      { url: "https://x/y.png" },
      { image_url: "https://x/y.png" },
      { image_url: { url: "https://x/y.png" } },
      { image_url: { file_id: "f" } },
      { file_id: "f" },
      { source: { type: "base64", data: "AA" } },
      { source: { type: "url", url: "https://x/y.png" } },
      { source: { type: "file", file_id: "f" } },
    ];
    for (const shape of shapes) {
      const resolved = resolveImageSource(shape);
      expect(resolved).toBeDefined();
      expect(resolved?.url !== undefined || resolved?.fileId !== undefined).toBe(true);
    }
  });
});

describe("normalizeBearerToken", () => {
  test("a single Bearer envelope is stripped", () => {
    // The reason: adapters must never emit `Bearer Bearer`.
    expect(normalizeBearerToken("Bearer sk-abc")).toBe("sk-abc");
  });

  test("the envelope match is case-insensitive", () => {
    expect(normalizeBearerToken("bearer sk-abc")).toBe("sk-abc");
    expect(normalizeBearerToken("BEARER sk-abc")).toBe("sk-abc");
  });

  test("a bare token is unchanged", () => {
    expect(normalizeBearerToken("sk-abc")).toBe("sk-abc");
  });

  test("exactly one envelope is stripped, so a doubled one is left half-fixed", () => {
    // MEASURED: `Bearer Bearer sk-abc` becomes `Bearer sk-abc` — the delegation to
    // `unwrapProviderToken` removes one envelope, not all. Pinned because the
    // module's own comment says "Strips a single leading Bearer envelope", so this
    // is intended, but a caller assuming full normalization would be wrong.
    expect(normalizeBearerToken("Bearer Bearer sk-abc")).toBe("Bearer sk-abc");
  });

  test("extra whitespace after the envelope is collapsed", () => {
    expect(normalizeBearerToken("Bearer  sk-abc")).toBe("sk-abc");
  });

  test("an empty string stays empty", () => {
    expect(normalizeBearerToken("")).toBe("");
  });
});

describe("filterProviderCustomHeaders", () => {
  test("an absent input yields an empty record", () => {
    expect(filterProviderCustomHeaders(undefined)).toEqual({});
    expect(filterProviderCustomHeaders({})).toEqual({});
  });

  test("a valid header is kept with a lower-cased name", () => {
    // Lower-casing is what makes the protected-name check reliable: HTTP header
    // names are case-insensitive, so `Authorization` and `authorization` must not
    // be treated differently.
    expect(filterProviderCustomHeaders({ "X-Custom": "v" })).toEqual({ "x-custom": "v" });
    expect(filterProviderCustomHeaders({ "X-Custom": "v", "Y-Other": "w" })).toEqual({
      "x-custom": "v",
      "y-other": "w",
    });
  });

  test("an invalid header name is rejected", () => {
    // RFC token grammar. A name with a space or colon would let an operator
    // inject a second header into the serialized block.
    for (const name of ["bad name", "bad:name", "", "bad\nname", "bad(x)"]) {
      const error = thrownBy(() => filterProviderCustomHeaders({ [name]: "v" }));
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).message).toContain("invalid custom header name");
    }
  });

  test("a non-string value is rejected", () => {
    for (const value of [42, null, undefined, true, { a: 1 }, ["v"]]) {
      const error = thrownBy(() => filterProviderCustomHeaders({ "x-a": value }));
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).message).toContain("must be a string");
    }
  });

  test("a value over 4KiB is rejected, and exactly 4KiB is accepted", () => {
    // The byte cap, not a character cap.
    expect(filterProviderCustomHeaders({ "x-a": "a".repeat(4096) })).toEqual({
      "x-a": "a".repeat(4096),
    });
    const error = thrownBy(() => filterProviderCustomHeaders({ "x-a": "a".repeat(4097) }));
    expect((error as GatewayError).message).toContain("exceeds 4KiB");
  });

  test("the cap counts BYTES, not code units", () => {
    // A multi-byte string within the character budget can still exceed the byte
    // budget: 2049 two-byte characters is 4098 bytes.
    const error = thrownBy(() => filterProviderCustomHeaders({ "x-a": "é".repeat(2049) }));
    expect((error as GatewayError).message).toContain("exceeds 4KiB");
    // And 2048 of them is exactly 4096 bytes, so it passes.
    expect(() => filterProviderCustomHeaders({ "x-a": "é".repeat(2048) })).not.toThrow();
  });

  test("a control character in the value is rejected", () => {
    // The reason: a CR or LF in a header value is the classic header-injection
    // vector.
    for (const value of ["bad\nvalue", "bad\rvalue", "bad\u0000value", "ok\tvalue"]) {
      const error = thrownBy(() => filterProviderCustomHeaders({ "x-a": value }));
      expect((error as GatewayError).message).toContain("control characters");
    }
  });

  test("protected credential and transport names are rejected", () => {
    // The core security property: an operator cannot override the gateway's own
    // credentials or framing.
    for (const name of ["authorization", "x-api-key", "host", "content-length"]) {
      const error = thrownBy(() => filterProviderCustomHeaders({ [name]: "v" }));
      expect((error as GatewayError).message).toContain("protected");
    }
  });

  test("every x-forwarded-* name is rejected, not just the known ones", () => {
    // The `startsWith("x-forwarded-")` guard. Without the prefix rule an operator
    // could set `x-forwarded-weird` and reach a proxy that honours it.
    for (const name of ["x-forwarded-for", "x-forwarded-weird", "X-Forwarded-Proto"]) {
      const error = thrownBy(() => filterProviderCustomHeaders({ [name]: "v" }));
      expect((error as GatewayError).message).toContain("protected");
    }
  });

  test("a provider-family reserved name is rejected too", () => {
    // The `extraAllowed` parameter is documented as "extra non-overridable
    // names" — despite the name, operator values for them are rejected.
    const error = thrownBy(() => filterProviderCustomHeaders({ "X-Extra": "v" }, ["x-extra"]));
    expect((error as GatewayError).message).toContain("protected");
    // Case-insensitively, because both sides are lower-cased.
    expect(thrownBy(() => filterProviderCustomHeaders({ "x-extra": "v" }, ["X-Extra"]))).toBeInstanceOf(
      GatewayError,
    );
  });

  test("a name that is not reserved passes through", () => {
    expect(filterProviderCustomHeaders({ "x-not-reserved": "v" }, ["x-other"])).toEqual({
      "x-not-reserved": "v",
    });
  });

  test("the rejection carries the offending header in its details", () => {
    // The details are what the operator's console shows, so the name must be
    // there rather than only in the message.
    const error = thrownBy(() => filterProviderCustomHeaders({ "x-forwarded-for": "1.2.3.4" })) as GatewayError;
    expect(error.details).toMatchObject({ header: "x-forwarded-for" });
    expect(error.status).toBe(400);
  });
});
