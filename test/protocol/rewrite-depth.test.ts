/**
 * The recursion bound shared by every request-supplied value rewriter.
 *
 * `primitives.ts` holds four helpers that walk a value the *caller* supplied —
 * a tool schema, a tool-call argument string, a thinking payload — and rewrite
 * it into something an upstream accepts. Each was plain recursion, and plain
 * recursion over caller data is a stack-overflow primitive: measured against
 * the code before this bound existed, a 120 KB body whose tool arguments nest
 * 20,000 deep parsed fine and then threw `RangeError: Maximum call stack size
 * exceeded` **inside the production encoder**
 * (`canonicalToClaudeMessagesPayload`).
 *
 * The ingress guard does not cover this. `MAX_JSON_DEPTH = 64` in
 * `body-policy.ts` measures the request *envelope*, and the Chat wire carries
 * tool arguments as a JSON **string** (`function.arguments`), so the nesting
 * is invisible to that guard and is only parsed here, afterwards.
 *
 * So these tests pin three properties, in order of how much they matter:
 *
 * 1. **The crash is gone** — deep and cyclic input returns instead of
 *    overflowing, through the real encoders, not just the helpers.
 * 2. **The bound is a bound, not a rewrite** — a value past it is forwarded
 *    *unchanged*. Discarding a caller's schema would be worse than forwarding
 *    a shape the upstream may reject on its own, and silently rewriting only
 *    the shallow part would corrupt a schema rather than refuse it.
 * 3. **Nothing below the bound changed** — the guards must be invisible to
 *    every value a real client sends.
 *
 * The cyclic cases are the ones a depth bound alone cannot fix: a two-node
 * loop overflows at *any* depth, which is why the walk carries the path it is
 * inside rather than only a counter.
 */
import { describe, expect, test } from "bun:test";
import {
  assertBoundedJsonDepth,
  completeRequiredSchema,
  escapeHarmonyControlTokensDeep,
  MAX_JSON_DEPTH,
  MAX_REWRITE_DEPTH,
  parseArguments,
  sanitizeSchemaForAnthropic,
  toWellFormedDeep,
} from "../../src/protocol/primitives";
import { GatewayError } from "../../src/transport/gateway-error";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { buildGeminiPayload } from "../../src/protocol/request/gemini";
import { buildClaudeMessagesRequest } from "../../src/providers/integrations/claude-messages";
import type { CanonicalRequest } from "../../src/transport/canonical-model";

/** Runs `body`, returning the thrown error — for asserting on rejections. */
function thrownBy(body: () => unknown): unknown {
  try {
    body();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** `{"a":{"a":…"leaf"…}}` as a JSON **string**, the Chat wire's argument shape. */
function nestedJsonString(depth: number): string {
  let text = '"leaf"';
  for (let i = 0; i < depth; i += 1) text = `{"a":${text}}`;
  return text;
}

/** The same nesting as an object graph, for the schema walkers. */
function nestedSchema(depth: number): unknown {
  let schema: unknown = { type: "string" };
  for (let i = 0; i < depth; i += 1) schema = { type: "object", properties: { a: schema } };
  return schema;
}

function nestedObject(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) value = { a: value };
  return value;
}

function nestedArray(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

/** A request the Messages encoder accepts, carrying `arguments` on one call. */
function messagesRequestWithArguments(argumentsText: string): CanonicalRequest {
  return {
    model: "m",
    messages: [
      { role: "user", content: [{ kind: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ kind: "toolCall", call_id: "call_1", name: "probe", arguments: argumentsText }],
      },
    ],
    generation_controls: {},
    tools: [],
  } as unknown as CanonicalRequest;
}

/** A Gemini request whose single tool carries `schema`. */
function geminiRequestWithSchema(schema: unknown): CanonicalRequest {
  return {
    model: "m",
    messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    generation_controls: {},
    tools: [{ name: "probe", jsonSchema: schema }],
  } as unknown as CanonicalRequest;
}

/**
 * Depth chosen to sit far past `MAX_REWRITE_DEPTH` **and** far past the
 * overflow point the unguarded code hit.
 *
 * Measured on the unguarded walkers: 10,000 levels return and 20,000 throw, so
 * the cliff is in between and its exact position moves with the stack the
 * runtime happens to have. 80,000 is four times past the highest measured
 * cliff, which is what makes "does not throw" a statement about the guard
 * rather than about leftover stack headroom — a test sitting at 20,000 passed
 * even with the bound removed.
 */
const BEYOND_BOUND = 80_000;

describe("rewrite depth bound: the crash it removes", () => {
  test("toWellFormedDeep survives nesting far past the bound", () => {
    expect(() => toWellFormedDeep(nestedObject(BEYOND_BOUND))).not.toThrow();
    expect(() => toWellFormedDeep(nestedArray(BEYOND_BOUND))).not.toThrow();
  });

  test("escapeHarmonyControlTokensDeep survives nesting far past the bound", () => {
    expect(() => escapeHarmonyControlTokensDeep(nestedObject(BEYOND_BOUND))).not.toThrow();
    expect(() => escapeHarmonyControlTokensDeep(nestedArray(BEYOND_BOUND))).not.toThrow();
  });

  test("sanitizeSchemaForAnthropic survives nesting far past the bound", () => {
    expect(() => sanitizeSchemaForAnthropic(nestedSchema(BEYOND_BOUND))).not.toThrow();
  });

  test("completeRequiredSchema survives nesting far past the bound", () => {
    expect(() => completeRequiredSchema(nestedSchema(BEYOND_BOUND))).not.toThrow();
  });

  test("a cycle at any depth returns instead of overflowing", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["self"] = cyclic;
    expect(() => toWellFormedDeep(cyclic)).not.toThrow();
    expect(() => escapeHarmonyControlTokensDeep(cyclic)).not.toThrow();
    expect(() => sanitizeSchemaForAnthropic(cyclic)).not.toThrow();
    expect(() => completeRequiredSchema(cyclic)).not.toThrow();
  });

  test("an array that contains itself returns instead of overflowing", () => {
    const cyclic: unknown[] = ["leaf"];
    cyclic.push(cyclic);
    expect(() => toWellFormedDeep(cyclic)).not.toThrow();
    expect(() => escapeHarmonyControlTokensDeep(cyclic)).not.toThrow();
  });

  test("a cycle nested below the bound is still stopped", () => {
    // The cycle sits ~10 levels down: a depth counter alone would recurse
    // until the stack ran out, so this is the case that proves the path check
    // is doing work of its own.
    const root: Record<string, unknown> = { type: "object" };
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < 10; i += 1) {
      const child: Record<string, unknown> = { type: "object" };
      cursor["child"] = child;
      cursor = child;
    }
    cursor["back"] = root;
    expect(() => sanitizeSchemaForAnthropic(root)).not.toThrow();
    expect(() => completeRequiredSchema(root)).not.toThrow();
    expect(() => toWellFormedDeep(root)).not.toThrow();
  });
});

describe("rewrite depth bound: reachable through the real encoders", () => {
  test("Messages tool arguments beyond the bound are rejected, not crashed on", () => {
    // Before the bound this threw `RangeError: Maximum call stack size
    // exceeded` from inside the encoder. It must now be a typed rejection the
    // error lifecycle can turn into a 400 — the same answer the envelope guard
    // gives the identical content sent as nested objects.
    const request = messagesRequestWithArguments(nestedJsonString(BEYOND_BOUND));
    expect(() => canonicalToClaudeMessagesPayload(request)).toThrow(GatewayError);
  });

  test("the rejection names the depth limit and is a client error", () => {
    const request = messagesRequestWithArguments(nestedJsonString(BEYOND_BOUND));
    const error = thrownBy(() => canonicalToClaudeMessagesPayload(request));
    expect(error).toBeInstanceOf(GatewayError);
    const gateway = error as GatewayError;
    expect(gateway.status).toBe(400);
    expect(gateway.code).toBe("invalid_request");
    expect(gateway.message).toContain("nesting exceeds");
  });

  test("arguments within the bound still encode normally", () => {
    // The bound must not clip real payloads: a schema-shaped argument nested a
    // handful of levels is what a genuine tool call carries.
    const request = messagesRequestWithArguments(JSON.stringify({ a: { b: { c: { d: "leaf" } } } }));
    const payload = canonicalToClaudeMessagesPayload(request);
    expect(JSON.stringify(payload)).toContain('"d":"leaf"');
  });

  test("Messages tool schema beyond the bound no longer crashes the encoder", () => {
    // A schema reaches the walker as a nested object, so the envelope guard
    // already rejects it on a real request; the walker's own bound is the
    // second line for non-ingress callers.
    const request = {
      model: "m",
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
      generation_controls: {},
      tools: [{ name: "probe", jsonSchema: nestedSchema(BEYOND_BOUND) }],
    } as unknown as CanonicalRequest;
    expect(() => canonicalToClaudeMessagesPayload(request)).not.toThrow();
  });

  test("Gemini tool schema beyond the bound no longer crashes the encoder", () => {
    expect(() => buildGeminiPayload(geminiRequestWithSchema(nestedSchema(BEYOND_BOUND)))).not.toThrow();
  });

  test("Gemini survives a cyclic tool schema", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["properties"] = { self: cyclic };
    expect(() => buildGeminiPayload(geminiRequestWithSchema(cyclic))).not.toThrow();
  });
});

describe("rewrite depth bound: one bound for both transports of the same content", () => {
  test("the production request builder rejects deep arguments and builds normal ones", () => {
    // The end of the real path: this is the function that produces the bytes
    // sent upstream, including the `JSON.stringify` that used to be the *last*
    // place a too-deep value crashed. Both halves matter — a bound that also
    // broke ordinary tool calls would be worse than the crash it replaced.
    // Both option and return types are module-private, so the call is built
    // inline and its result inferred rather than annotated.
    const build = (argumentsText: string) =>
      buildClaudeMessagesRequest({
        request: messagesRequestWithArguments(argumentsText),
        credential: { secret: "sk-ant-EXAMPLE", customHeaders: {} },
        authHeader: "x-api-key",
        baseUrl: "https://example.test",
        endpointPath: "/v1/messages",
        gatewayUserAgent: "cartethyia/test",
      });

    const ordinary = build(nestedJsonString(5));
    expect(ordinary.body.length).toBeGreaterThan(0);
    expect(ordinary.body).toContain('"tool_use"');

    expect(() => build(nestedJsonString(MAX_JSON_DEPTH + 1))).toThrow(GatewayError);
    expect(() => build(nestedJsonString(BEYOND_BOUND))).toThrow(GatewayError);
  });

  test("a JSON string cannot carry nesting an object would be rejected for", () => {
    // The whole reason `parseArguments` checks depth itself: the ingress guard
    // measures the envelope, and `function.arguments` is a string leaf inside
    // it. Without this, the string form was an unbounded bypass of a limit the
    // object form was held to.
    const tooDeep = MAX_JSON_DEPTH + 1;
    const asObjects = nestedObject(tooDeep);
    // The object form is what the middleware rejects.
    expect(() => assertBoundedJsonDepth(asObjects)).toThrow(GatewayError);
    // The string form now reaches the same verdict at the same depth.
    expect(() => parseArguments(JSON.stringify(asObjects))).toThrow(GatewayError);
  });

  test("the two enforcement points accept and reject the same depths", () => {
    for (const depth of [1, 10, MAX_JSON_DEPTH - 1, MAX_JSON_DEPTH, MAX_JSON_DEPTH + 1]) {
      const value = nestedObject(depth);
      const envelopeAccepts = thrownBy(() => assertBoundedJsonDepth(value)) === undefined;
      const stringAccepts = thrownBy(() => parseArguments(JSON.stringify(value))) === undefined;
      expect(stringAccepts).toBe(envelopeAccepts);
    }
  });

  test("a value nested exactly at the bound is still accepted", () => {
    // The bound is inclusive, matching the middleware's `depth > MAX` test.
    expect(() => assertBoundedJsonDepth(nestedObject(MAX_JSON_DEPTH))).not.toThrow();
    expect(() => parseArguments(JSON.stringify(nestedObject(MAX_JSON_DEPTH)))).not.toThrow();
  });

  test("an unparseable argument string is still forwarded verbatim", () => {
    // A non-JSON argument string is a caller error the upstream reports in its
    // own words; the depth guard must not convert it into a rejection.
    expect(parseArguments("not json at all")).toBe("not json at all");
  });
});

describe("rewrite depth bound: past the bound is forwarded, not mangled", () => {
  /**
   * Walks `levels` property hops down an object chain built by `nest`.
   *
   * The bound is checked *before* descending, so the node at nesting level
   * `MAX_REWRITE_DEPTH` is the first one returned as-is; everything above it
   * is still rebuilt normally. These helpers reach that exact node so the
   * assertions name the stop point instead of describing the root, which is
   * always a fresh object for the schema walkers.
   */
  function atDepth(value: unknown, levels: number): unknown {
    let cursor = value;
    for (let i = 0; i < levels; i += 1) cursor = (cursor as Record<string, unknown>)["a"];
    return cursor;
  }

  /** The same hop for the `properties.a` chain the schema walkers use. */
  function schemaAtDepth(value: unknown, levels: number): unknown {
    let cursor = value;
    for (let i = 0; i < levels; i += 1) {
      cursor = ((cursor as Record<string, unknown>)["properties"] as Record<string, unknown>)["a"];
    }
    return cursor;
  }

  test("toWellFormedDeep forwards the node at the bound untouched", () => {
    // A lone surrogate sits below the bound, so it is never reached and the
    // whole chain comes back by identity — the guard did not clone it.
    const deep = nestedObject(MAX_REWRITE_DEPTH + 5);
    const leaf = "\uD800";
    let withLeaf: unknown = leaf;
    for (let i = 0; i < MAX_REWRITE_DEPTH + 5; i += 1) withLeaf = { a: withLeaf };
    expect(atDepth(toWellFormedDeep(withLeaf), MAX_REWRITE_DEPTH + 5)).toBe(leaf);
    expect(toWellFormedDeep(deep)).toBe(deep);
  });

  test("sanitizeSchemaForAnthropic forwards the node at the bound untouched", () => {
    // `format` is a keyword this sanitizer drops. Build the chain with a
    // marked leaf so the assertion can tell "rewritten" from "forwarded":
    // below the bound the marker is dropped, at the stop point it survives.
    let marked: unknown = { type: "string", format: "date" };
    for (let i = 0; i < MAX_REWRITE_DEPTH + 5; i += 1) {
      marked = { type: "object", properties: { a: marked } };
    }
    const out = sanitizeSchemaForAnthropic(marked);
    const leaf = schemaAtDepth(out, MAX_REWRITE_DEPTH + 5) as Record<string, unknown>;
    expect(leaf).toEqual({ type: "string", format: "date" });
    // Above the bound the same sanitizer still drops it — the guard is what
    // changed the outcome, not a broken sanitizer.
    expect(sanitizeSchemaForAnthropic({ type: "string", format: "date" })).toEqual({
      type: "string",
    });
  });

  test("completeRequiredSchema forwards the node at the bound untouched", () => {
    const schema = nestedSchema(MAX_REWRITE_DEPTH + 5);
    const out = completeRequiredSchema(schema);
    const atBound = schemaAtDepth(out, MAX_REWRITE_DEPTH) as Record<string, unknown>;
    // The node at the bound is returned as-is, so it carries no `required`
    // list — the walk never inspected its `properties`.
    expect("required" in atBound).toBe(false);
  });

  test("escapeHarmonyControlTokensDeep forwards the node at the bound untouched", () => {
    let withToken: unknown = "<|start|>";
    for (let i = 0; i < MAX_REWRITE_DEPTH + 5; i += 1) withToken = { a: withToken };
    const out = escapeHarmonyControlTokensDeep(withToken);
    // Below the bound the reserved token is still raw, so the escape did not
    // run there.
    expect(atDepth(out, MAX_REWRITE_DEPTH + 5)).toBe("<|start|>");
    // Above the bound the escape did run, so the two levels differ.
    expect(atDepth(out, MAX_REWRITE_DEPTH - 1)).not.toBe(atDepth(withToken, MAX_REWRITE_DEPTH - 1));
  });

  test("a cycle is closed by pointing back at the original node", () => {
    // The stop returns the node itself, so the cycle stays a cycle rather than
    // being flattened or cloned — the caller's object identity survives at the
    // stop point even though the root above it is a rebuild.
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["properties"] = { self: cyclic };
    const out = sanitizeSchemaForAnthropic(cyclic) as Record<string, unknown>;
    const properties = out["properties"] as Record<string, unknown>;
    expect(properties["self"]).toBe(cyclic);
  });
});

describe("rewrite depth bound: invisible below it", () => {
  test("toWellFormedDeep still repairs a lone surrogate at a shallow depth", () => {
    expect(toWellFormedDeep({ a: "\uD800", b: ["\uDC00", 1] })).toEqual({
      a: "�",
      b: ["�", 1],
    });
  });

  test("toWellFormedDeep still returns the same reference when nothing changed", () => {
    const clean = { a: "ok", b: ["fine", 1] };
    expect(toWellFormedDeep(clean)).toBe(clean);
  });

  test("sanitizeSchemaForAnthropic still drops unsupported keywords", () => {
    expect(sanitizeSchemaForAnthropic({ type: "string", format: "date", pattern: "x" })).toEqual({
      type: "string",
      pattern: "x",
    });
  });

  test("sanitizeSchemaForAnthropic still rebuilds required from properties", () => {
    expect(sanitizeSchemaForAnthropic({ properties: { a: { type: "string" } } })).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  test("completeRequiredSchema still marks every property required", () => {
    expect(completeRequiredSchema({ properties: { a: { type: "string" } } })).toEqual({
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  test("escapeHarmonyControlTokensDeep still escapes a reserved token", () => {
    expect(escapeHarmonyControlTokensDeep({ a: "<|start|>" })).toEqual({ a: "<\\|start\\|>" });
  });

  test("a shared subtree appearing twice is not mistaken for a cycle", () => {
    // The path check is per-branch, so a legitimately reused subschema (the
    // same object referenced from two properties) must still be rewritten in
    // both places. A `seen`-set implementation would have stopped at the
    // second reference and silently dropped the rewrite there.
    const shared = { type: "string", format: "date" };
    const out = sanitizeSchemaForAnthropic({
      type: "object",
      properties: { first: shared, second: shared },
    }) as Record<string, unknown>;
    expect(out["properties"]).toEqual({
      first: { type: "string" },
      second: { type: "string" },
    });
  });

  test("nesting just under the bound is still fully rewritten", () => {
    // The bound must not clip a legitimate deep schema: at MAX_REWRITE_DEPTH
    // the walk still descends, so the deepest leaf is rewritten.
    const schema = nestedSchema(MAX_REWRITE_DEPTH - 1);
    const out = sanitizeSchemaForAnthropic(schema);
    expect(out).not.toBe(schema);
    expect(JSON.stringify(out)).toContain('"type":"string"');
  });
});

describe("rewrite depth bound: the exported signature stays single-argument", () => {
  test("each rewriter takes exactly one declared parameter", () => {
    // `Array.prototype.map` passes the element index as the second argument.
    // If `depth` were an exported second parameter, a bare
    // `.map(toWellFormedDeep)` would hand the index to it — and past the bound
    // the guard would forward the value unrewritten instead of failing loudly.
    // The single-parameter signature is what makes that call a type error.
    for (const fn of [
      toWellFormedDeep,
      escapeHarmonyControlTokensDeep,
      sanitizeSchemaForAnthropic,
      completeRequiredSchema,
    ]) {
      expect(fn.length).toBe(1);
    }
  });

  test("a bare .map() still rewrites every element, whatever its index", () => {
    // The concrete failure the signature prevents. An index would arrive as
    // `depth`, so an element at index >= MAX_REWRITE_DEPTH would be forwarded
    // unrewritten while its neighbours were sanitized — a silently
    // half-rewritten array. `format` is the marker: dropped when rewritten,
    // present when the element was skipped.
    const values = Array.from({ length: MAX_REWRITE_DEPTH + 50 }, () => ({
      type: "string",
      format: "date",
    }));
    const mapped = values.map(sanitizeSchemaForAnthropic) as Record<string, unknown>[];
    expect(mapped.every((entry) => !("format" in entry))).toBe(true);
    expect(mapped[0]).toEqual({ type: "string" });
    expect(mapped[MAX_REWRITE_DEPTH + 49]).toEqual({ type: "string" });
  });
});
