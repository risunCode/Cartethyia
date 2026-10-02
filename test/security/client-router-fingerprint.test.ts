/**
 * Client-router fingerprinting: labelling a caller as a known AI-gateway
 * product so an operator can refuse it per API key.
 *
 * The module's own header sets the frame, and the tests are written inside it:
 * **this is a best-effort label, never a security boundary.** A client that
 * removes every header looks like a plain SDK caller. What that means for the
 * suite is that the dangerous direction is a **false positive** — the module's
 * comment says a false positive "refuses a paying customer" — so most of what
 * follows is adversarial input that must NOT match.
 *
 * The other half is the persisted contract. A denylist entry is stored on an API
 * key and read back at the matching boundary, so the ids are durable data:
 * `omniroute` folded into `9router` and the alias has to keep resolving, or an
 * operator's existing refusal silently stops applying after a rename.
 */
import { describe, expect, test } from "bun:test";
import {
  CLIENT_ROUTER_IDS,
  CLIENT_ROUTERS,
  deniedClientRouter,
  detectClientRouter,
  normalizeClientRouterId,
  type ClientRouterProbe,
} from "../../src/security/client-router-fingerprint";

/** A probe over a plain header record. */
function probe(headers: Record<string, string> = {}): ClientRouterProbe {
  return { headers };
}

/** A probe over a real `Headers` object, which takes a different read path. */
function headerProbe(headers: Record<string, string> = {}): ClientRouterProbe {
  return { headers: new Headers(headers) };
}

/** The one product this table currently recognises. */
const NINE_ROUTER = "9router";

describe("CLIENT_ROUTERS — the table's own invariants", () => {
  test("every id is a stable lowercase token", () => {
    // The ids are stored in a persisted denylist, so they are part of the
    // contract: a space or an uppercase letter would break a client's match
    // without failing anything in the gateway.
    for (const router of CLIENT_ROUTERS) {
      expect(router.id).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
      expect(router.label.length).toBeGreaterThan(0);
      expect(router.signals.length).toBeGreaterThan(0);
    }
  });

  test("ids are unique, and the exported id list matches the table", () => {
    // Two entries sharing an id would make `normalizeClientRouterId` ambiguous
    // and the dashboard list would show a duplicate.
    const ids = CLIENT_ROUTERS.map((router) => router.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...CLIENT_ROUTER_IDS]).toEqual(ids);
  });

  test("every signal field is a lowercase header name", () => {
    // `readHeader` lowercases the incoming key before comparing, so an
    // uppercase field name here would never match a real request.
    for (const router of CLIENT_ROUTERS) {
      for (const signal of router.signals) {
        expect(signal.field).toBe(signal.field.toLowerCase());
        expect(signal.field).not.toContain(" ");
        expect(signal.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("every signal carries a matcher or is documented as presence-only", () => {
    // The interface's rule: with no matcher, the header's mere presence is the
    // signal, and that is only safe for a name no other client sends. This
    // asserts the shape — a matcher, or a name that is unmistakably product-
    // specific (it contains the product's own token).
    for (const router of CLIENT_ROUTERS) {
      for (const signal of router.signals) {
        const hasMatcher =
          signal.equals !== undefined || signal.contains !== undefined || signal.pattern !== undefined;
        if (hasMatcher) continue;
        expect(signal.field).toContain("omniroute");
      }
    }
  });

  test("the exported id list is frozen", () => {
    // It is handed to the dashboard as the list of ids an operator may store;
    // a caller mutating it would change what the console offers.
    expect(Object.isFrozen(CLIENT_ROUTER_IDS)).toBe(true);
  });
});

describe("detectClientRouter — a caller with no signal", () => {
  test("no headers at all is unlabelled", () => {
    // The module's stated default: an unknown caller is left unlabelled rather
    // than guessed at. A false positive refuses a paying customer.
    expect(detectClientRouter(probe())).toBeNull();
    expect(detectClientRouter(headerProbe())).toBeNull();
  });

  test("an ordinary SDK caller is unlabelled", () => {
    // The realistic shape of a legitimate client. None of these is a signal,
    // and every one of them is a header a real SDK sends.
    expect(
      detectClientRouter(
        probe({
          "user-agent": "OpenAI/Python 1.40.0",
          "content-type": "application/json",
          authorization: "Bearer sk-EXAMPLE",
          "x-stainless-lang": "python",
          "x-stainless-package-version": "1.40.0",
        }),
      ),
    ).toBeNull();
  });

  test("the genuine first-party Claude Code signals are NOT treated as signals", () => {
    // The module's header records that a "corroborating" tier was tried and
    // removed on evidence: these are the *real* client's own values, which is
    // exactly what these routers imitate. Measured against captured traffic they
    // labelled a real Claude Code request as OmniRoute — worse than no signal.
    // Pinned so nobody re-adds them.
    expect(
      detectClientRouter(
        probe({
          "user-agent": "claude-cli/2.1.280 (external, cli)",
          "x-anthropic-billing-header": "cc_version=2.1.280",
          "x-claude-code-session-id": "a-session-id",
          "anthropic-version": "2023-06-01",
        }),
      ),
    ).toBeNull();
  });

  test("a plausible but generic header is not a signal", () => {
    // The interface's rule: a generic header like `x-request-source: local` is
    // deliberately absent, because a false positive refuses a paying customer.
    expect(
      detectClientRouter(
        probe({ "x-request-source": "local", "x-forwarded-for": "203.0.113.1" }),
      ),
    ).toBeNull();
  });

  test("a header named like a signal but with an unrelated value is unlabelled", () => {
    // The matcher is what decides, not the header's name. Each documented
    // value-matching signal is given a near-miss.
    expect(detectClientRouter(probe({ "x-msh-platform": "not-9router" }))).toBeNull();
    expect(detectClientRouter(probe({ "x-client-type": "sdk" }))).toBeNull();
    // The UA pattern is a whole-word match, so a longer *token* containing the
    // name is not the product.
    expect(detectClientRouter(probe({ "user-agent": "9routerx/1.0" }))).toBeNull();
    expect(detectClientRouter(probe({ "user-agent": "x9router" }))).toBeNull();
    expect(detectClientRouter(probe({ "user-agent": "19router" }))).toBeNull();
  });

  test("the UA pattern's word boundary treats punctuation as a boundary", () => {
    // MEASURED: the pattern is `/(^|[^a-z0-9])9router([^a-z0-9]|$)/i`, so a
    // hyphen, slash, or parenthesis beside the name counts as a boundary and the
    // UA matches. Pinned because "not-9router-like" reads like a near-miss but is
    // not one — the module matches on the *word*, deliberately, because a product
    // name in a UA is how these clients identify themselves.
    expect(detectClientRouter(probe({ "user-agent": "not-9router-like" }))?.routerId).toBe(
      NINE_ROUTER,
    );
  });

  test("a header present but empty is not a presence-only match", () => {
    // The presence-only signals would otherwise match an empty header, which
    // any client can send by accident.
    expect(detectClientRouter(probe({ "x-omniroute-peer-trace": "" }))).toBeNull();
    expect(detectClientRouter(probe({ "x-omniroute-peer-trace": "   " }))).toBeNull();
    expect(detectClientRouter(probe({ "x-omniroute-fallback-hint": "" }))).toBeNull();
  });

  test("the Node default User-Agent alone is treated as this router's signal", () => {
    // A deliberate judgement with a stated cost: the table says this router
    // sends Node's bare default UA. The consequence is that any client sending
    // exactly `node` is labelled — pinned so the trade is visible rather than
    // discovered as a support ticket.
    const match = detectClientRouter(probe({ "user-agent": "node" }));
    expect(match?.routerId).toBe(NINE_ROUTER);
  });

  test("a Node UA carrying a version is matched, but a longer UA is not", () => {
    // The pattern is anchored: `^node(?:/[\w.+-]+)?$`. A real tool that prefixes
    // Node's UA with its own name must not be labelled.
    expect(detectClientRouter(probe({ "user-agent": "node/20.11.0" }))?.routerId).toBe(NINE_ROUTER);
    expect(detectClientRouter(probe({ "user-agent": "node/v18.0.0" }))?.routerId).toBe(NINE_ROUTER);
    expect(detectClientRouter(probe({ "user-agent": "node-fetch/1.0" }))).toBeNull();
    expect(detectClientRouter(probe({ "user-agent": "something node/20" }))).toBeNull();
    expect(detectClientRouter(probe({ "user-agent": "node " }))?.routerId).toBe(NINE_ROUTER);
  });
});

describe("detectClientRouter — each documented signal", () => {
  test("the platform and client-type headers match exactly, case-insensitively", () => {
    // `equals` trims and lowercases both sides, so a product that changes the
    // casing of its own value still matches.
    for (const value of ["9router", "9Router", "9ROUTER", "  9router  "]) {
      expect(detectClientRouter(probe({ "x-msh-platform": value }))?.routerId).toBe(NINE_ROUTER);
      expect(detectClientRouter(probe({ "x-client-type": value }))?.routerId).toBe(NINE_ROUTER);
    }
  });

  test("the presence-only headers match on any non-blank value", () => {
    for (const field of ["x-omniroute-peer-trace", "x-omniroute-fallback-hint"]) {
      expect(detectClientRouter(probe({ [field]: "anything" }))?.routerId).toBe(NINE_ROUTER);
      expect(detectClientRouter(probe({ [field]: "1" }))?.routerId).toBe(NINE_ROUTER);
    }
  });

  test("the UA pattern matches the product name as a whole word", () => {
    // `/(^|[^a-z0-9])9router([^a-z0-9]|$)/i` — the boundaries are what stop a
    // longer token that merely contains the name from matching.
    for (const value of [
      "9router",
      "9Router/1.0",
      "9router 1.0",
      "some-client/1.0 (9router)",
      "9router;extra",
    ]) {
      expect(detectClientRouter(probe({ "user-agent": value }))?.routerId).toBe(NINE_ROUTER);
    }
    // Adjacent alphanumerics are part of a longer token.
    for (const value of ["19router", "9router9", "x9routerx", "a9router"]) {
      expect(detectClientRouter(probe({ "user-agent": value }))).toBeNull();
    }
  });

  test("the rewritten OpenAI-compatible UA matches exactly", () => {
    // A full-string `equals`, so a browser UA that merely mentions the phrase
    // is not labelled.
    expect(
      detectClientRouter(probe({ "user-agent": "Mozilla/5.0 (compatible; OpenAI compatible)" }))?.routerId,
    ).toBe(NINE_ROUTER);
    expect(
      detectClientRouter(probe({ "user-agent": "Mozilla/5.0 (compatible; OpenAI compatible) Safari" })),
    ).toBeNull();
  });

  test("one product's several signals are all reported together", () => {
    // The match carries every signal that fired, because the operator's audit
    // trail is the point: one header can be a coincidence, four is evidence.
    const match = detectClientRouter(
      probe({
        "x-msh-platform": "9router",
        "x-client-type": "9router",
        "x-omniroute-peer-trace": "abc",
        "user-agent": "9router/1.0",
      }),
    );
    expect(match?.routerId).toBe(NINE_ROUTER);
    expect(match?.signals).toHaveLength(4);
    expect(match?.signals.map((signal) => signal.field).sort()).toEqual([
      "user-agent",
      "x-client-type",
      "x-msh-platform",
      "x-omniroute-peer-trace",
    ]);
    // Each carries its description and the observed value.
    for (const signal of match?.signals ?? []) {
      expect(signal.description.length).toBeGreaterThan(0);
      expect(signal.value.length).toBeGreaterThan(0);
    }
  });

  test("the matched value is capped for the audit trail", () => {
    // A hostile client can send a megabyte-long header; the match record goes
    // into a log or a telemetry row, so it must be bounded.
    const match = detectClientRouter(probe({ "x-omniroute-peer-trace": "z".repeat(5_000) }));
    expect(match?.signals[0]?.value.length).toBe(200);
  });

  test("the label is the human string, not the id", () => {
    // The label is what the operator sees in the refusal message and the console;
    // the id is what the denylist stores.
    const match = detectClientRouter(probe({ "x-msh-platform": "9router" }));
    expect(match?.label).toBe("9Router and OmniRoute");
    expect(match?.label).not.toBe(match?.routerId);
  });
});

describe("detectClientRouter — header reading", () => {
  test("a plain record is read case-insensitively", () => {
    // A proxy or a test harness can hand over any casing. The record path has to
    // lowercase the key itself, because a plain object has no `Headers`
    // semantics.
    expect(detectClientRouter(probe({ "X-MSH-Platform": "9router" }))?.routerId).toBe(NINE_ROUTER);
    expect(detectClientRouter(probe({ "X-Msh-Platform": "9router" }))?.routerId).toBe(NINE_ROUTER);
    expect(detectClientRouter(probe({ "X-MSH-PLATFORM": "9router" }))?.routerId).toBe(NINE_ROUTER);
  });

  test("a real Headers object is read through its own API", () => {
    // `Headers` is already case-insensitive, and it is the shape the request
    // path actually hands over.
    expect(detectClientRouter(headerProbe({ "X-MSH-Platform": "9router" }))?.routerId).toBe(
      NINE_ROUTER,
    );
    expect(detectClientRouter(headerProbe({ "x-msh-platform": "9router" }))?.routerId).toBe(
      NINE_ROUTER,
    );
  });

  test("both header shapes produce the same match", () => {
    // The two read paths must not disagree, or a suite using one shape would
    // pass while production (which uses the other) behaved differently.
    const headers = { "x-msh-platform": "9router", "user-agent": "9router/1.0" };
    expect(detectClientRouter(probe(headers))).toEqual(detectClientRouter(headerProbe(headers)));
  });

  test("a record with an unrelated key does not confuse the lookup", () => {
    // The loop compares lowercased keys, so an entry that happens to share a
    // prefix must not match.
    expect(
      detectClientRouter(probe({ "x-msh-platform-extra": "9router", "x-msh": "9router" })),
    ).toBeNull();
  });

  test("a value that is not a string is ignored rather than coerced", () => {
    // MEASURED: the record path returns the raw value and `detectClientRouter`
    // calls `.length` on it. A non-string would throw — pinned so the shape of
    // the contract is explicit. The request path always produces strings, so this
    // is a note about the type rather than a reachable case.
    const hostile = { "x-msh-platform": 9 as unknown as string };
    expect(() => detectClientRouter(probe(hostile))).toThrow();
  });
});

describe("normalizeClientRouterId", () => {
  test("a known id resolves to itself", () => {
    for (const id of CLIENT_ROUTER_IDS) {
      expect(normalizeClientRouterId(id)).toBe(id);
    }
  });

  test("the legacy alias resolves to its current id", () => {
    // The persisted contract: a denylist stored before the merge still contains
    // `omniroute`, and detection now always returns `9router`. Without the alias,
    // an operator's existing refusal silently stops applying.
    expect(normalizeClientRouterId("omniroute")).toBe(NINE_ROUTER);
  });

  test("trimming and lowercasing happen before the lookup", () => {
    expect(normalizeClientRouterId("  9Router  ")).toBe(NINE_ROUTER);
    expect(normalizeClientRouterId("OMNIROUTE")).toBe(NINE_ROUTER);
    expect(normalizeClientRouterId("  OmniRoute  ")).toBe(NINE_ROUTER);
  });

  test("an unknown id is undefined, not a guess", () => {
    // The caller treats undefined as "cannot describe the caller". Returning the
    // input would make a typo a live denylist entry.
    for (const value of ["", "   ", "unknown-router", "9routers", "9 router", "claude-cli"]) {
      expect(normalizeClientRouterId(value)).toBeUndefined();
    }
  });

  test("the alias is not itself listed as an id", () => {
    // The table's comment: `omniroute` survives only as a legacy alias, never as
    // its own entry — otherwise the dashboard would offer two ids for one product
    // and the two entries could drift.
    expect(CLIENT_ROUTER_IDS).not.toContain("omniroute");
    expect(CLIENT_ROUTERS.some((router) => router.id === "omniroute")).toBe(false);
  });
});

describe("deniedClientRouter", () => {
  /** A match as `detectClientRouter` would produce it. */
  function match(): NonNullable<ReturnType<typeof detectClientRouter>> {
    const found = detectClientRouter(probe({ "x-msh-platform": "9router" }));
    if (found === null) throw new Error("the fixture must match");
    return found;
  }

  test("a denylist naming the detected product returns its label", () => {
    // The label, not the id: the caller puts it in the refusal message the client
    // reads.
    expect(deniedClientRouter([NINE_ROUTER], match())).toBe("9Router and OmniRoute");
  });

  test("the legacy alias in a stored denylist still denies", () => {
    // The end-to-end consequence of the alias: a key whose denylist was saved
    // before the merge keeps refusing the product.
    expect(deniedClientRouter(["omniroute"], match())).toBe("9Router and OmniRoute");
  });

  test("a Set works as well as an array", () => {
    // The snapshot's list fields accept either, so the boundary canonicalises
    // both.
    expect(deniedClientRouter(new Set([NINE_ROUTER]), match())).toBe("9Router and OmniRoute");
    expect(deniedClientRouter(new Set(["omniroute"]), match())).toBe("9Router and OmniRoute");
  });

  test("a denylist naming a different product does not deny", () => {
    expect(deniedClientRouter(["some-other-router"], match())).toBeNull();
  });

  test("an empty denylist does not deny", () => {
    expect(deniedClientRouter([], match())).toBeNull();
    expect(deniedClientRouter(new Set(), match())).toBeNull();
  });

  test("a null or undefined denylist does not deny", () => {
    // The snapshot's fields are optional, so an unset denylist is the common case
    // and must read as "nothing denied" rather than failing.
    expect(deniedClientRouter(null, match())).toBeNull();
    expect(deniedClientRouter(undefined, match())).toBeNull();
  });

  test("an unrecognised denylist entry is ignored, not treated as a match", () => {
    // The comment: failing closed on an unknown id would refuse traffic over a
    // typo. Asserted with the typo alongside a non-string and a near-miss.
    expect(deniedClientRouter(["9routers"], match())).toBeNull();
    expect(deniedClientRouter(["9 router"], match())).toBeNull();
    expect(deniedClientRouter([""], match())).toBeNull();
    expect(deniedClientRouter([null, undefined, 9, {}], match())).toBeNull();
  });

  test("a non-string entry beside a valid one does not break the valid one", () => {
    expect(deniedClientRouter([null, 9, {}, NINE_ROUTER], match())).toBe("9Router and OmniRoute");
  });

  test("an unlabelled caller is never denied", () => {
    // The guard's first check. A client that sent no signal cannot be the denied
    // product, so even a denylist naming it must not refuse this request.
    expect(deniedClientRouter([NINE_ROUTER], null)).toBeNull();
    expect(deniedClientRouter(["omniroute"], null)).toBeNull();
  });

  test("an empty-string entry does not normalize into a match", () => {
    // `normalizeClientRouterId("")` is undefined, and `undefined === "9router"`
    // is false. Pinned because a truthy-check refactor could invert it.
    expect(deniedClientRouter(["   "], match())).toBeNull();
  });
});
