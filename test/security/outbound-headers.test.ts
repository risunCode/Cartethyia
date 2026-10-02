/**
 * The header boundary: what a caller may NOT inject into an outbound request,
 * and what a browser is told it may do with a gateway response.
 *
 * Two halves, both security-shaped.
 *
 * **Protected headers** (`isProtectedHeader`, `HEADER_TOKEN`, `HEADER_CONTROL`)
 * decide which custom headers an operator may set on a provider. The list is the
 * set of names that carry routing, identity, or framing meaning, so a caller who
 * could set one would redirect the request (`host`), impersonate a tenant
 * (`x-cartethyia-tenant`), forge the client address (`x-forwarded-for`), or break
 * the connection (`transfer-encoding`). The two regexes are the other boundary:
 * a header name or value carrying CR/LF is a request-splitting primitive, and a
 * name outside the token grammar is not a header at all.
 *
 * **Content-Security-Policy** decides what the dashboard is allowed to execute.
 * The inline-script hashes are the mechanism that keeps `'unsafe-inline'` out of
 * `script-src`: the page's own bootstrap script is allowed by its SHA-256, so a
 * script an attacker manages to inject is not. That only holds if the hash is
 * computed over exactly the bytes the browser hashes, so the extraction is
 * asserted against the HTML shapes the server actually emits.
 */
import { describe, expect, test } from "bun:test";
import {
  API_CONTENT_SECURITY_POLICY,
  BADGE_IMAGE_ORIGIN,
  BASE_PROTECTED_HEADERS,
  dashboardContentSecurityPolicy,
  GATEWAY_SECURITY_HEADERS,
  HEADER_CONTROL,
  HEADER_TOKEN,
  inlineScriptBodies,
  inlineScriptContentSecurityPolicy,
  inlineScriptHash,
  isProtectedHeader,
  X_FRAME_OPTIONS,
} from "../../src/security/outbound-headers";

describe("isProtectedHeader", () => {
  test("every base-protected name is protected, case-insensitively", () => {
    // A caller setting `Host` or `HOST` must be refused exactly as `host` is; a
    // case-sensitive compare would let the mixed-case spelling through, and the
    // outbound header map is lowercased by the HTTP layer.
    for (const name of Object.keys(BASE_PROTECTED_HEADERS)) {
      expect(isProtectedHeader(name)).toBe(true);
      expect(isProtectedHeader(name.toUpperCase())).toBe(true);
    }
  });

  test("the framing and identity headers are protected", () => {
    // Each of these is a distinct redirect or impersonation primitive, called out
    // individually so removing one from the list fails here.
    for (const name of [
      "host",
      "authorization",
      "x-api-key",
      "cookie",
      "transfer-encoding",
      "content-length",
      "connection",
      "x-cartethyia-tenant",
      "x-cartethyia-surface",
    ]) {
      expect(isProtectedHeader(name)).toBe(true);
    }
  });

  test("any x-forwarded-* name is protected, including one not enumerated", () => {
    // The prefix rule is the extensible half of the list: a new `X-Forwarded-*`
    // header must be protected without someone remembering to add it.
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "x-forwarded-prefix",
      "x-forwarded-something-new",
      "X-Forwarded-Something-New",
    ]) {
      expect(isProtectedHeader(name)).toBe(true);
    }
  });

  test("an ordinary provider header is not protected", () => {
    // The list must not block the headers a provider integration legitimately
    // needs, or the feature becomes unusable.
    for (const name of [
      "anthropic-version",
      "openai-beta",
      "x-custom-trace",
      "user-agent",
      "accept",
      "accept-encoding",
    ]) {
      expect(isProtectedHeader(name)).toBe(false);
    }
  });

  test("a name that merely resembles a protected one is not protected", () => {
    // Exact membership plus the `x-forwarded-` prefix. A near-miss like
    // `x-forwardedx` or `host-header` must not be blocked, and `x-cartethyia-tenantx`
    // must not be either.
    for (const name of [
      "x-forwardedx",
      "xforwarded-for",
      "host-header",
      "x-cartethyia-tenantx",
      "x-cartethyia",
      "authorization-header",
    ]) {
      expect(isProtectedHeader(name)).toBe(false);
    }
  });

  test("the extra list is honoured on top of the base list", () => {
    // The parameter is how a caller adds context-specific names (a provider's own
    // routing header) without editing the shared list.
    expect(isProtectedHeader("x-provider-route", { "x-provider-route": true })).toBe(true);
    expect(isProtectedHeader("x-provider-route")).toBe(false);
    // The base list still applies.
    expect(isProtectedHeader("host", { "x-provider-route": true })).toBe(true);
  });

  test("an empty or malformed name is not protected", () => {
    // The predicate answers "is this a protected header", not "is this a valid
    // header" — validation is the regexes' job. Pinned so a caller cannot rely on
    // this to reject a bad name.
    expect(isProtectedHeader("")).toBe(false);
    expect(isProtectedHeader("not a header")).toBe(false);
    expect(isProtectedHeader("x-forwarded-")).toBe(true);
  });
});

describe("HEADER_TOKEN — the name grammar", () => {
  test("accepts the documented token shapes", () => {
    for (const name of ["a", "x", "x-custom", "anthropic-version", "x1", "1x", "a-b-c", "x-cartethyia-surface"]) {
      expect(HEADER_TOKEN.test(name)).toBe(true);
    }
  });

  test("rejects a name that is empty, too long, or badly bounded", () => {
    // The grammar is `[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?` — 64 characters max,
    // and it may not start or end with a hyphen.
    expect(HEADER_TOKEN.test("")).toBe(false);
    expect(HEADER_TOKEN.test("-x")).toBe(false);
    expect(HEADER_TOKEN.test("x-")).toBe(false);
    expect(HEADER_TOKEN.test("x_custom")).toBe(false);
    expect(HEADER_TOKEN.test("x custom")).toBe(false);
    expect(HEADER_TOKEN.test("x:custom")).toBe(false);
    expect(HEADER_TOKEN.test("X-Custom")).toBe(false);
    // 64 characters is the longest accepted.
    expect(HEADER_TOKEN.test("a".repeat(64))).toBe(true);
    expect(HEADER_TOKEN.test("a".repeat(65))).toBe(false);
    expect(HEADER_TOKEN.test(`${"a".repeat(63)}-`)).toBe(false);
    expect(HEADER_TOKEN.test(`-${"a".repeat(63)}`)).toBe(false);
  });

  test("rejects a name carrying a control character", () => {
    // A name with CR/LF is a request-splitting primitive; the grammar excludes it
    // by construction.
    expect(HEADER_TOKEN.test("x-custom\r\nX-Evil")).toBe(false);
    expect(HEADER_TOKEN.test("x-custom\0")).toBe(false);
    expect(HEADER_TOKEN.test("x-custom\t")).toBe(false);
  });
});

describe("HEADER_CONTROL — the value grammar", () => {
  test("matches every control character that could split a request", () => {
    // CR and LF are the request-splitting pair; NUL and the rest of the C0 range
    // are rejected for the same reason.
    expect(HEADER_CONTROL.test("value\r\nX-Evil: 1")).toBe(true);
    expect(HEADER_CONTROL.test("value\nX-Evil: 1")).toBe(true);
    expect(HEADER_CONTROL.test("value\rX-Evil: 1")).toBe(true);
    expect(HEADER_CONTROL.test("value\0")).toBe(true);
    expect(HEADER_CONTROL.test("value\tinside")).toBe(true);
    expect(HEADER_CONTROL.test("value\x1f")).toBe(true);
    expect(HEADER_CONTROL.test("value\x7f")).toBe(true);
  });

  test("accepts an ordinary header value, including a space", () => {
    // A space is legal in a header value and common in the ones a provider needs.
    expect(HEADER_CONTROL.test("Bearer sk-EXAMPLE")).toBe(false);
    expect(HEADER_CONTROL.test("")).toBe(false);
    expect(HEADER_CONTROL.test("a b c")).toBe(false);
    // A non-ASCII value is not a control character.
    expect(HEADER_CONTROL.test("café")).toBe(false);
  });
});

describe("GATEWAY_SECURITY_HEADERS", () => {
  test("carries the documented hardening set on every key", () => {
    // The list's whole reason for existing is that three paths had drifted and
    // the success path was missing the CSP pair. One list means a future
    // hardening cannot land on one path and miss the others.
    expect(GATEWAY_SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(GATEWAY_SECURITY_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(GATEWAY_SECURITY_HEADERS["cross-origin-opener-policy"]).toBe("same-origin");
    expect(GATEWAY_SECURITY_HEADERS["cross-origin-resource-policy"]).toBe("same-origin");
    expect(GATEWAY_SECURITY_HEADERS["content-security-policy"]).toBe(API_CONTENT_SECURITY_POLICY);
    expect(GATEWAY_SECURITY_HEADERS["x-frame-options"]).toBe(X_FRAME_OPTIONS);
    expect(GATEWAY_SECURITY_HEADERS["permissions-policy"]).toContain("camera=()");
  });

  test("the API policy denies everything a JSON response does not need", () => {
    // These endpoints never serve a script, a frame, or a form, so the policy
    // closes all three. Asserted on the directives rather than the whole string,
    // so a reordering does not fail the suite but a removed directive does.
    for (const directive of [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]) {
      expect(API_CONTENT_SECURITY_POLICY).toContain(directive);
    }
    // No `unsafe-inline` anywhere: the API policy is the strict one.
    expect(API_CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(API_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });

  test("the header map is frozen", () => {
    // It is applied to every response from several call sites; a mutation would
    // change the headers on unrelated paths.
    expect(Object.isFrozen(GATEWAY_SECURITY_HEADERS)).toBe(true);
  });

  test("every header name is lowercase and every value is control-free", () => {
    // The map is spread onto a response object, where a mixed-case name or a
    // control character would be a framing defect.
    for (const [name, value] of Object.entries(GATEWAY_SECURITY_HEADERS)) {
      expect(name).toBe(name.toLowerCase());
      expect(HEADER_CONTROL.test(name)).toBe(false);
      expect(HEADER_CONTROL.test(value)).toBe(false);
    }
  });
});

describe("inlineScriptBodies", () => {
  test("extracts an inline script body", () => {
    const html = "<html><head><script>console.log('hi')</script></head></html>";
    expect(inlineScriptBodies(html)).toEqual(["console.log('hi')"]);
  });

  test("ignores a script with a src attribute", () => {
    // The whole point of the extraction: a bundled module is covered by
    // `'self'`, so hashing it would add a useless directive and a maintenance
    // burden every time the bundle changed.
    const html = '<script src="/assets/app.js"></script><script>inline()</script>';
    expect(inlineScriptBodies(html)).toEqual(["inline()"]);
  });

  test("ignores a src attribute in any position and any case", () => {
    // The lookahead is `(?![^>]*\bsrc=)`, so `src` may appear anywhere in the
    // tag and the tag name is case-insensitive.
    const html = [
      '<SCRIPT SRC="/a.js"></SCRIPT>',
      '<script defer src="/b.js"></script>',
      '<script src="/c.js" defer></script>',
      '<script>kept()</script>',
    ].join("");
    expect(inlineScriptBodies(html)).toEqual(["kept()"]);
  });

  test("ignores a script whose body is blank", () => {
    // A blank body has a hash, but the hash is of nothing and adds no value;
    // including it would put a meaningless directive in the policy.
    const html = "<script>   </script><script>\n\n</script><script>real()</script>";
    expect(inlineScriptBodies(html)).toEqual(["real()"]);
  });

  test("preserves the body byte-for-byte, including newlines and indentation", () => {
    // The hash is computed over exactly these bytes, and the browser hashes
    // exactly what is between the tags. Any normalisation here would produce a
    // hash that never matches and the script would be blocked.
    const body = "\n    const theme = 'dark';\n    document.documentElement.dataset.theme = theme;\n  ";
    const html = `<script>${body}</script>`;
    expect(inlineScriptBodies(html)).toEqual([body]);
  });

  test("extracts several inline scripts in document order", () => {
    const html = "<script>first()</script><script>second()</script>";
    expect(inlineScriptBodies(html)).toEqual(["first()", "second()"]);
  });

  test("handles a body containing a `>` character", () => {
    // A non-greedy `[\s\S]*?` up to `</script>`, so a comparison inside the
    // script does not end the match early.
    const html = "<script>if (a > b) { run() }</script>";
    expect(inlineScriptBodies(html)).toEqual(["if (a > b) { run() }"]);
  });

  test("handles a body containing HTML-looking text", () => {
    // A script that writes markup as a string must not be truncated at the first
    // `</` that is not `</script>`.
    const html = "<script>document.body.innerHTML = '<div>hi</div>'</script>";
    expect(inlineScriptBodies(html)).toEqual(["document.body.innerHTML = '<div>hi</div>'"]);
  });

  test("an HTML document with no script returns an empty list", () => {
    expect(inlineScriptBodies("<html><body>hi</body></html>")).toEqual([]);
    expect(inlineScriptBodies("")).toEqual([]);
  });

  test("a self-closing or unterminated script tag yields nothing", () => {
    // A `<script/>` has no body, and an unterminated tag has no closing token for
    // the pattern to match. Neither should produce a partial body.
    expect(inlineScriptBodies("<script/>")).toEqual([]);
    expect(inlineScriptBodies("<script>never closed")).toEqual([]);
  });
});

describe("inlineScriptHash", () => {
  test("produces the CSP sha256 source expression", () => {
    // The exact form a browser expects in `script-src`: quoted, with the
    // algorithm prefix.
    expect(inlineScriptHash("")).toBe(
      "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
    );
  });

  test("is a base64 SHA-256 of the UTF-8 bytes", () => {
    // A non-ASCII body is the case where a wrong encoding would produce a hash
    // the browser never matches, blocking the script.
    const hash = inlineScriptHash("café");
    expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]+={0,2}'$/);
    // Deterministic, and different for a different body.
    expect(inlineScriptHash("café")).toBe(hash);
    expect(inlineScriptHash("cafe")).not.toBe(hash);
  });

  test("a one-byte change produces a different hash", () => {
    expect(inlineScriptHash("run()")).not.toBe(inlineScriptHash("run( )"));
  });
});

/** The `script-src` directive of a policy, as its own string. */
function scriptSrcOf(policy: string): string {
  const directive = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("script-src"));
  if (directive === undefined) throw new Error(`no script-src in: ${policy}`);
  return directive;
}

describe("dashboardContentSecurityPolicy", () => {
  test("allows exactly the inline scripts present in the document", () => {
    // The mechanism that keeps `'unsafe-inline'` out of `script-src`: the page's
    // own bootstrap is allowed by hash, so an injected script is not.
    const html = "<script>bootstrap()</script>";
    const policy = dashboardContentSecurityPolicy(html);
    expect(policy).toContain(inlineScriptHash("bootstrap()"));
    expect(scriptSrcOf(policy)).toBe(`script-src 'self' ${inlineScriptHash("bootstrap()")}`);
  });

  test("a document with no inline script gets a plain `script-src 'self'`", () => {
    // No dangling space and no empty directive, which a strict CSP parser would
    // reject as a syntax error and then ignore the whole policy.
    const policy = dashboardContentSecurityPolicy("<html></html>");
    expect(scriptSrcOf(policy)).toBe("script-src 'self'");
  });

  test("script-src never gains unsafe-inline or unsafe-eval", () => {
    // `style-src` carries `'unsafe-inline'` deliberately (React `style` props),
    // so the assertion has to be on the script directive specifically — checking
    // the whole policy would either fail on the style rule or, if relaxed to a
    // substring check, miss a regression that added the token to script-src.
    for (const html of ["", "<script>x()</script>", "<script src='/a.js'></script>"]) {
      const directive = scriptSrcOf(dashboardContentSecurityPolicy(html));
      expect(directive).not.toContain("unsafe-inline");
      expect(directive).not.toContain("unsafe-eval");
    }
  });

  test("style-src allows inline and Google Fonts, as documented", () => {
    // React `style` props need `unsafe-inline` for styles, and the fonts come
    // from Google. The comment is explicit that only `img-src` is widened beyond
    // this.
    const policy = dashboardContentSecurityPolicy("");
    expect(policy).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(policy).toContain("font-src 'self' https://fonts.gstatic.com");
  });

  test("connect-src stays 'self', so the page cannot call a third party", () => {
    // The stated invariant. Widening `connect-src` is what would turn an XSS
    // into data exfiltration, so it is asserted directly.
    expect(dashboardContentSecurityPolicy("")).toContain("connect-src 'self'");
  });

  test("img-src admits the badge origin and nothing else beyond self/data/blob", () => {
    // The badge host is admitted for the repository star/fork SVGs. It must never
    // be able to supply a script or a style, which is why only `img-src` names it.
    const policy = dashboardContentSecurityPolicy("");
    expect(policy).toContain(`img-src 'self' data: blob: https: ${BADGE_IMAGE_ORIGIN}`);
    // The origin appears in exactly one directive.
    expect(policy.split(BADGE_IMAGE_ORIGIN).length - 1).toBe(1);
  });

  test("the framing and base directives are the strict ones", () => {
    const policy = dashboardContentSecurityPolicy("");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  test("the policy is a single header value with no control characters", () => {
    // The value goes into a response header; a newline would split it and the
    // rest would be parsed as another header.
    const policy = dashboardContentSecurityPolicy("<script>x()</script>");
    expect(HEADER_CONTROL.test(policy)).toBe(false);
    expect(policy.includes("\n")).toBe(false);
  });

  test("a document with a hostile inline script still hashes it rather than widening", () => {
    // The policy cannot distinguish a legitimate bootstrap from an injected
    // script — it hashes whatever is there. Pinned so the consequence is
    // explicit: the hash list is a description of the document, and the defence
    // against injection is that the document itself is not attacker-controlled.
    // The alternative — reaching for `'unsafe-inline'` — is what this asserts
    // against, on the script directive specifically.
    const hostile = "<script>steal(document.cookie)</script>";
    const policy = dashboardContentSecurityPolicy(hostile);
    expect(scriptSrcOf(policy)).toBe(`script-src 'self' ${inlineScriptHash("steal(document.cookie)")}`);
    expect(scriptSrcOf(policy)).not.toContain("unsafe-inline");
  });
});

describe("inlineScriptContentSecurityPolicy", () => {
  test("allows exactly the bodies it is given", () => {
    const policy = inlineScriptContentSecurityPolicy(["first()", "second()"]);
    expect(policy).toContain(inlineScriptHash("first()"));
    expect(policy).toContain(inlineScriptHash("second()"));
    expect(policy).toContain("default-src 'none'");
  });

  test("with no bodies it denies scripts outright", () => {
    // The API policy denies scripts entirely, so a page that must run one
    // declares its hash here. With nothing to declare the directive has to say
    // `'none'` — an empty `script-src` would be a syntax error the browser
    // ignores, silently falling back to `default-src 'none'` at best.
    expect(inlineScriptContentSecurityPolicy([])).toContain("script-src 'none'");
  });

  test("never contains unsafe-inline or unsafe-eval in the script directive", () => {
    // This is the helper that exists precisely to avoid `unsafe-inline` on a
    // small page; a regression that added it would defeat the purpose.
    for (const bodies of [[], ["x()"], ["a()", "b()"]]) {
      const directive = scriptSrcOf(inlineScriptContentSecurityPolicy(bodies));
      expect(directive).not.toContain("unsafe-inline");
      expect(directive).not.toContain("unsafe-eval");
    }
  });

  test("the framing directives are the strict ones", () => {
    const policy = inlineScriptContentSecurityPolicy(["x()"]);
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  test("the policy is a single header value with no control characters", () => {
    const policy = inlineScriptContentSecurityPolicy(["x()"]);
    expect(HEADER_CONTROL.test(policy)).toBe(false);
    expect(policy.includes("\n")).toBe(false);
  });
});

describe("BASE_PROTECTED_HEADERS", () => {
  test("every key is lowercase", () => {
    // `isProtectedHeader` lowercases the incoming name before the lookup, so an
    // uppercase key here would be unreachable.
    for (const name of Object.keys(BASE_PROTECTED_HEADERS)) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  test("the list is frozen", () => {
    expect(Object.isFrozen(BASE_PROTECTED_HEADERS)).toBe(true);
  });

  test("the hop-by-hop headers are all present", () => {
    // These are connection-scoped and must never be forwarded; forwarding
    // `transfer-encoding` or `connection` breaks the outbound request.
    for (const name of [
      "connection",
      "keep-alive",
      "proxy-connection",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]) {
      expect(BASE_PROTECTED_HEADERS[name]).toBe(true);
    }
  });

  test("the credential-bearing headers are all present", () => {
    // A caller setting one of these would replace the provider credential the
    // gateway just resolved, or the caller's own authentication.
    for (const name of ["authorization", "x-api-key", "cookie", "proxy-authorization"]) {
      expect(BASE_PROTECTED_HEADERS[name]).toBe(true);
    }
  });
});
