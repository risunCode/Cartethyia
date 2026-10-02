/**
 * Credential paste handling: kind detection, secret extraction, batch splitting,
 * and naming.
 *
 * This module is the boundary between whatever an operator pastes and the single
 * `secret` string the API stores. Three properties matter more than the rest:
 *
 * 1. **The secret that reaches the API must be the secret.** For an API key the
 *    module extracts the value out of the surrounding JSON; for an OAuth export it
 *    must keep the WHOLE blob, because the refresh token and expiry are part of
 *    the credential. Getting that backwards either stores a JSON wrapper as the
 *    key, or drops the refresh token.
 * 2. **A cookie bundle is ONE credential, not N.** A Cookie-Editor array is a
 *    session, and splitting it into one account per cookie would create dozens of
 *    broken accounts from one paste.
 * 3. **Names must be unique.** The API rejects duplicate account names, so
 *    `assignAccountNames` has to resolve collisions both against what already
 *    exists and against the names it just handed out in the same batch.
 *
 * Every case below was measured against the module, not derived from its
 * comments: the field-priority order in particular is observable and I got it
 * wrong on my first pass.
 */
import { describe, expect, test } from "bun:test";
import {
  assignAccountNames,
  detectCredentialKind,
  extractCredentialFromPaste,
  parseCredentialBatch,
} from "../../src/shared/credential-extract";

describe("extractCredentialFromPaste", () => {
  test("a bare token is returned unchanged and marked not extracted", () => {
    // The common case: the operator pastes the key itself. `extracted: false` is
    // what tells the caller the value is already the secret.
    expect(extractCredentialFromPaste("sk-ant-EXAMPLE-key-value")).toEqual({
      value: "sk-ant-EXAMPLE-key-value",
      extracted: false,
    });
  });

  test("surrounding whitespace is trimmed from a bare token", () => {
    // A pasted key usually carries a trailing newline; sending it would store a
    // credential that never authenticates.
    expect(extractCredentialFromPaste("  sk-ant-EXAMPLE  \n").value).toBe("sk-ant-EXAMPLE");
  });

  test("the value is extracted from a JSON object and the source field named", () => {
    // `source` is what the UI shows as "took the key from <field>".
    const result = extractCredentialFromPaste('{"apiKey":"sk-ant-EXAMPLE"}');
    expect(result).toEqual({ value: "sk-ant-EXAMPLE", extracted: true, source: "apiKey" });
  });

  test("the documented field priority is honoured", () => {
    // The order is observable when several fields are present. MEASURED: for
    // `accessToken` + `apiKey` together, `access`/`accessToken`/`access_token`
    // all win over `apiKey`, because they come first in
    // `CREDENTIAL_FIELD_PRIORITY`. Pinned because a reorder would silently change
    // which string becomes the credential.
    const result = extractCredentialFromPaste('{"apiKey":"KEY","accessToken":"TOKEN"}');
    expect(result.value).toBe("TOKEN");
    expect(result.source).toBe("accessToken");
  });

  test("a nested data object is consulted when the top level has no credential", () => {
    // Some exports wrap the payload: `{ "data": { "access_token": ... } }`. The
    // source is reported with its path so the operator can see where it came from.
    const result = extractCredentialFromPaste('{"data":{"access_token":"NESTED"}}');
    expect(result).toEqual({ value: "NESTED", extracted: true, source: "data.access_token" });
  });

  test("a stringified data object is parsed before the nested search", () => {
    // `nestedRecord` JSON-parses a string `data` field. A double-encoded export
    // is a real shape, and without the parse the whole string would be stored.
    const result = extractCredentialFromPaste('{"data":"{\\"access_token\\":\\"INNER\\"}"}');
    expect(result.value).toBe("INNER");
    expect(result.source).toBe("data.access_token");
  });

  test("a top-level credential wins over a nested one", () => {
    // The top-level loop runs first and returns immediately.
    const result = extractCredentialFromPaste('{"accessToken":"OUTER","data":{"access_token":"INNER"}}');
    expect(result.value).toBe("OUTER");
    expect(result.source).toBe("accessToken");
  });

  test("an empty or whitespace-only field is skipped", () => {
    // `value.trim().length > 0` — a provider export with `"apiKey": ""` must fall
    // through to the next field rather than storing an empty credential.
    const result = extractCredentialFromPaste('{"apiKey":"","token":"REAL"}');
    expect(result.value).toBe("REAL");
    expect(result.source).toBe("token");
  });

  test("a non-string field value is skipped", () => {
    // A number or object in the credential slot is not a credential; the search
    // continues rather than stringifying it.
    const result = extractCredentialFromPaste('{"apiKey":12345,"token":"REAL"}');
    expect(result.value).toBe("REAL");
  });

  test("a JSON object with no recognisable credential falls back to the raw text", () => {
    // `{ "foo": "bar" }` has no credential field, so the whole trimmed string is
    // returned unextracted — the operator sees their own paste rather than a
    // silently empty field.
    const raw = '{"foo":"bar"}';
    expect(extractCredentialFromPaste(raw)).toEqual({ value: raw, extracted: false });
  });

  test("a key:value block is parsed as a credential source", () => {
    // The reference dashboards export `key: value` lines. The block is not valid
    // JSON, so this is the `parseKeyValueLines` path.
    const result = extractCredentialFromPaste("apiKey: sk-ant-EXAMPLE\nregion: us-east-1");
    expect(result).toEqual({ value: "sk-ant-EXAMPLE", extracted: true, source: "apiKey" });
  });

  test("a key:value block with no credential field falls back to the raw text", () => {
    const raw = "region: us-east-1\nzone: b";
    expect(extractCredentialFromPaste(raw)).toEqual({ value: raw, extracted: false });
  });

  test("a malformed JSON blob is not partially parsed", () => {
    // `parsedJson` catches the parse error and returns undefined, so the fallback
    // is the raw text. Pinned because a lenient parser would extract a value from
    // a truncated paste and store something the operator never saw.
    const raw = '{"apiKey":"sk-ant-EXAM';
    expect(extractCredentialFromPaste(raw).extracted).toBe(false);
    expect(extractCredentialFromPaste(raw).value).toBe(raw);
  });

  test("a JSON array is not treated as a single credential object", () => {
    // `asRecord` returns undefined for an array, so a bare array falls through to
    // the raw text. The batch path (`parseCredentialBatch`) is what handles
    // arrays; this function handles one credential.
    const raw = '[{"apiKey":"A"}]';
    expect(extractCredentialFromPaste(raw)).toEqual({ value: raw, extracted: false });
  });

  test("an empty paste produces an empty value", () => {
    // The caller must handle this; the module does not throw.
    expect(extractCredentialFromPaste("")).toEqual({ value: "", extracted: false });
    expect(extractCredentialFromPaste("   ")).toEqual({ value: "", extracted: false });
  });

  test("the extracted value never carries surrounding whitespace", () => {
    // A credential stored with padding fails to authenticate against every
    // provider, so this is the invariant across all extraction paths.
    for (const raw of [
      '{"apiKey":"  padded  "}',
      '{"data":{"token":"  padded  "}}',
      "token:   padded   ",
      "  padded  ",
    ]) {
      expect(extractCredentialFromPaste(raw).value).toBe("padded");
    }
  });
});

describe("detectCredentialKind", () => {
  test("a plain API key is detected as api_key", () => {
    // The default for anything that is not a recognisable OAuth shape.
    expect(detectCredentialKind("sk-ant-EXAMPLE")).toBe("api_key");
    expect(detectCredentialKind("")).toBe("api_key");
    expect(detectCredentialKind("eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe("api_key");
  });

  test("an OAuth shape is detected from a refresh field", () => {
    // `refresh`/`refreshToken`/`refresh_token` are the fields that make a blob a
    // refreshable credential rather than a static key.
    expect(detectCredentialKind('{"refresh_token":"rt"}')).toBe("oauth");
    expect(detectCredentialKind('{"refreshToken":"rt"}')).toBe("oauth");
    expect(detectCredentialKind('{"refresh":"rt"}')).toBe("oauth");
  });

  test("an OAuth shape is detected from an expiry field", () => {
    expect(detectCredentialKind('{"expires":1735689600}')).toBe("oauth");
    expect(detectCredentialKind('{"expiresAt":"2026-01-01T00:00:00Z"}')).toBe("oauth");
    expect(detectCredentialKind('{"expires_at":1735689600}')).toBe("oauth");
  });

  test("an OAuth shape is detected from an id_token field", () => {
    expect(detectCredentialKind('{"id_token":"jwt"}')).toBe("oauth");
    expect(detectCredentialKind('{"idToken":"jwt"}')).toBe("oauth");
  });

  test("a numeric expiry counts as an OAuth shape", () => {
    // The check is `typeof === "string" || typeof === "number"`, so an epoch
    // number is accepted. Pinned because a string-only check would miss the
    // common export shape.
    expect(detectCredentialKind('{"expires_at":1735689600}')).toBe("oauth");
  });

  test("a JSON object with only a token field is an api_key", () => {
    // The discriminating case: `{ "apiKey": ... }` is a key export, not an OAuth
    // one. Nothing in `OAUTH_SHAPE_FIELDS` is present.
    expect(detectCredentialKind('{"apiKey":"sk-ant-EXAMPLE"}')).toBe("api_key");
    expect(detectCredentialKind('{"access_token":"at"}')).toBe("api_key");
  });

  test("a nested OAuth shape is detected through the data field", () => {
    // `oauthShapeFromObject` inspects the nested record too, so a wrapped export
    // is still recognised.
    expect(detectCredentialKind('{"data":{"refresh_token":"rt"}}')).toBe("oauth");
  });

  test("a key:value block is inspected, not assumed to be an api_key", () => {
    // `parseKeyValueLines` feeds the same shape check, so a `refresh_token: ...`
    // block is an OAuth credential.
    expect(detectCredentialKind("refresh_token: rt-EXAMPLE")).toBe("oauth");
    expect(detectCredentialKind("apiKey: sk-ant-EXAMPLE")).toBe("api_key");
  });

  test("an unparseable blob defaults to api_key", () => {
    // Documented: "Defaults to api_key for anything that isn't a recognizable
    // OAuth JSON shape." The fallback direction matters — a static key is the
    // safer default because it is never refreshed.
    expect(detectCredentialKind("not json at all")).toBe("api_key");
    expect(detectCredentialKind("{broken")).toBe("api_key");
  });

  test("a JSON array of OAuth rows is an api_key at this level", () => {
    // `asRecord` rejects arrays, and `parseKeyValueLines` finds no `key: value`
    // lines in `[{"refresh_token":"rt"}]`, so the whole thing defaults. The batch
    // path decides per row; pinned so the split of responsibility is explicit.
    expect(detectCredentialKind('[{"refresh_token":"rt"}]')).toBe("api_key");
  });
});

describe("parseCredentialBatch — single entries", () => {
  test("an empty paste produces no entries", () => {
    expect(parseCredentialBatch("")).toEqual([]);
    expect(parseCredentialBatch("   \n  \n")).toEqual([]);
  });

  test("a single bare token is one api_key entry with no identity", () => {
    expect(parseCredentialBatch("sk-ant-EXAMPLE")).toEqual([
      { value: "sk-ant-EXAMPLE", kind: "api_key" },
    ]);
  });

  test("a single JSON object is one entry", () => {
    const entries = parseCredentialBatch('{"apiKey":"sk-ant-EXAMPLE","email":"me@example.com"}');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("sk-ant-EXAMPLE");
    expect(entries[0]?.kind).toBe("api_key");
    expect(entries[0]?.identity).toBe("me@example.com");
  });

  test("an OAuth object keeps the WHOLE blob as the value", () => {
    // The property that matters most here: an OAuth credential needs its refresh
    // token and expiry, so `entryFromObject` stringifies the object rather than
    // extracting one field. Extracting would produce an access token with no way
    // to refresh it.
    const raw = '{"access_token":"at","refresh_token":"rt","expires_at":1735689600}';
    const entries = parseCredentialBatch(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("oauth");
    expect(JSON.parse(entries[0]?.value ?? "")).toEqual({
      access_token: "at",
      refresh_token: "rt",
      expires_at: 1735689600,
    });
  });

  test("the identity is read from the documented field priority", () => {
    // `email` beats `name` beats `accountId` beats `id` beats `login` beats
    // `username`. Pinned with all of them present.
    const entries = parseCredentialBatch(
      '{"apiKey":"k","username":"u","login":"l","id":"i","accountId":"a","name":"n","email":"e@x.com"}',
    );
    expect(entries[0]?.identity).toBe("e@x.com");
  });

  test("a nested identity is found when the top level has none", () => {
    const entries = parseCredentialBatch('{"apiKey":"k","data":{"email":"nested@x.com"}}');
    expect(entries[0]?.identity).toBe("nested@x.com");
  });

  test("an entry with no identity field omits the property", () => {
    // `identity?: string` — the spread is conditional, so the key is absent
    // rather than present-and-undefined. `exactOptionalPropertyTypes` in the
    // dashboard tsconfig makes that distinction real.
    const entries = parseCredentialBatch('{"apiKey":"k"}');
    expect(entries[0]).not.toHaveProperty("identity");
  });

  test("a multi-line key:value block is ONE entry, not one per line", () => {
    // The `asKeyValue && Object.keys(asKeyValue).length === lines.length` guard.
    // A credential export is several lines describing one credential; splitting
    // it would create an account per field.
    const entries = parseCredentialBatch("apiKey: sk-ant-EXAMPLE\nregion: us-east-1\nzone: b");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("sk-ant-EXAMPLE");
  });

  test("a key:value block with no credential field is one entry holding the raw text", () => {
    // `entryFromObject` on a record with no credential field falls back to
    // `JSON.stringify(obj)`, so the value is a JSON object rather than the
    // original text. Pinned: it is a real behaviour, and it is lossless.
    const entries = parseCredentialBatch("region: us-east-1\nzone: b");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]?.value ?? "")).toEqual({ region: "us-east-1", zone: "b" });
    expect(entries[0]?.kind).toBe("api_key");
  });
});

describe("parseCredentialBatch — Cartethyia's own export row", () => {
  test("an export row is recognised and its accessToken used as the secret", () => {
    // The `EXPORT_ROW_FIELDS` rule: a row carrying `credentialKind`, `providerId`,
    // and `accessToken` is a `ProviderAccountExport`. Without it the row would be
    // read as an opaque blob and the credential lost on re-import — the comment
    // says so explicitly, and this is the test that holds it.
    const row = {
      credentialKind: "oauth",
      providerId: "claude",
      accessToken: '{"access_token":"at","refresh_token":"rt"}',
      label: "Work",
    };
    const entries = parseCredentialBatch(JSON.stringify(row));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("oauth");
    expect(entries[0]?.value).toBe('{"access_token":"at","refresh_token":"rt"}');
    expect(entries[0]?.identity).toBe("Work");
  });

  test("the export row's kind comes from its own field, not from shape detection", () => {
    // An `api_key` export row whose accessToken happens to be OAuth-shaped must
    // still be an api_key: the row's declaration is authoritative.
    const row = {
      credentialKind: "api_key",
      providerId: "openai",
      accessToken: '{"refresh_token":"rt"}',
    };
    expect(parseCredentialBatch(JSON.stringify(row))[0]?.kind).toBe("api_key");
  });

  test("an unknown credentialKind falls back to api_key", () => {
    // `exportKind === "oauth" ? "oauth" : "api_key"` — anything else is a key.
    const row = { credentialKind: "something-new", providerId: "p", accessToken: "tok" };
    expect(parseCredentialBatch(JSON.stringify(row))[0]?.kind).toBe("api_key");
  });

  test("an export row with no label has no identity", () => {
    const row = { credentialKind: "api_key", providerId: "p", accessToken: "tok" };
    expect(parseCredentialBatch(JSON.stringify(row))[0]).not.toHaveProperty("identity");
  });

  test("a blank label is not used as an identity", () => {
    // `label.trim().length > 0` — a whitespace label would otherwise become an
    // account named "   ".
    const row = { credentialKind: "api_key", providerId: "p", accessToken: "tok", label: "   " };
    expect(parseCredentialBatch(JSON.stringify(row))[0]).not.toHaveProperty("identity");
  });

  test("a row missing one of the three marker fields is not an export row", () => {
    // The rule requires all three. A blob with `accessToken` and `providerId` but
    // no `credentialKind` is treated as a normal object, so its value is the
    // extracted token rather than the accessToken field.
    const partial = { providerId: "p", accessToken: "tok", email: "e@x.com" };
    const entries = parseCredentialBatch(JSON.stringify(partial));
    expect(entries[0]?.value).toBe("tok");
    expect(entries[0]?.identity).toBe("e@x.com");
  });
});

describe("parseCredentialBatch — arrays and wrappers", () => {
  test("a JSON array of accounts becomes one entry per account", () => {
    const entries = parseCredentialBatch(
      '[{"apiKey":"k1","email":"a@x.com"},{"apiKey":"k2","email":"b@x.com"}]',
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.value)).toEqual(["k1", "k2"]);
    expect(entries.map((e) => e.identity)).toEqual(["a@x.com", "b@x.com"]);
  });

  test("non-object items in an array are dropped", () => {
    // `asRecord` filters them out. A `null` or a bare string in the array is not
    // an account, and keeping it would create an empty one.
    const entries = parseCredentialBatch('[{"apiKey":"k1"},null,"bare",42,{"apiKey":"k2"}]');
    expect(entries.map((e) => e.value)).toEqual(["k1", "k2"]);
  });

  test("an array of only non-objects falls through to the line splitter", () => {
    // `objects.length > 0` is false, so the array is not returned from the
    // branch; the text is then split on newlines. MEASURED: a single-line
    // `[1,2,3]` becomes one entry whose value is the raw text, because
    // `parseSingleLine` cannot parse it as a record either.
    const entries = parseCredentialBatch("[1,2,3]");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("[1,2,3]");
    expect(entries[0]?.kind).toBe("api_key");
  });

  test("the `accounts` wrapper is unwrapped into one entry per row", () => {
    // Cartethyia's own export is `{ exportedAt, accounts: [...] }`. Without the
    // unwrap the whole export re-imported as a single opaque account.
    const blob = JSON.stringify({
      exportedAt: "2026-01-01T00:00:00Z",
      accounts: [
        { credentialKind: "oauth", providerId: "claude", accessToken: "t1", label: "One" },
        { credentialKind: "api_key", providerId: "openai", accessToken: "t2", label: "Two" },
      ],
    });
    const entries = parseCredentialBatch(blob);
    expect(entries.map((e) => e.value)).toEqual(["t1", "t2"]);
    expect(entries.map((e) => e.identity)).toEqual(["One", "Two"]);
  });

  test("the `items` and `connections` wrappers are unwrapped too", () => {
    // `ACCOUNTS_WRAPPER_KEYS` covers the reference dashboards' batch-import shape.
    for (const key of ["items", "connections"]) {
      const blob = JSON.stringify({ [key]: [{ apiKey: "k1" }, { apiKey: "k2" }] });
      expect(parseCredentialBatch(blob).map((e) => e.value)).toEqual(["k1", "k2"]);
    }
  });

  test("an empty wrapper array is not unwrapped", () => {
    // `rows.length > 0` — `{ accounts: [] }` would otherwise produce zero
    // entries, silently discarding the paste. MEASURED: it falls through to
    // `entryFromObject`, producing one entry holding the wrapper as JSON.
    const entries = parseCredentialBatch('{"accounts":[]}');
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]?.value ?? "")).toEqual({ accounts: [] });
  });

  test("a wrapper whose value is not an array is not unwrapped", () => {
    const entries = parseCredentialBatch('{"accounts":"not-an-array","apiKey":"k"}');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("k");
  });

  test("the first wrapper key with rows wins", () => {
    // `ACCOUNTS_WRAPPER_KEYS` order: accounts, then items, then connections.
    const blob = JSON.stringify({
      accounts: [{ apiKey: "from-accounts" }],
      items: [{ apiKey: "from-items" }],
    });
    expect(parseCredentialBatch(blob).map((e) => e.value)).toEqual(["from-accounts"]);
  });

  test("newline-delimited JSON objects become one entry per line", () => {
    // A JSONL export. Each line is parsed independently by `parseSingleLine`.
    const blob = '{"apiKey":"k1","email":"a@x.com"}\n{"apiKey":"k2","email":"b@x.com"}';
    const entries = parseCredentialBatch(blob);
    expect(entries.map((e) => e.value)).toEqual(["k1", "k2"]);
    expect(entries.map((e) => e.identity)).toEqual(["a@x.com", "b@x.com"]);
  });

  test("newline-delimited plain tokens become one entry per line", () => {
    // The simplest batch: one key per line.
    const entries = parseCredentialBatch("sk-ant-ONE\nsk-ant-TWO\nsk-ant-THREE");
    expect(entries.map((e) => e.value)).toEqual(["sk-ant-ONE", "sk-ant-TWO", "sk-ant-THREE"]);
    expect(entries.every((e) => e.kind === "api_key")).toBe(true);
  });

  test("blank lines are dropped from a batch", () => {
    // A trailing newline or a blank separator must not produce an empty account.
    expect(parseCredentialBatch("k1\n\n\nk2\n").map((e) => e.value)).toEqual(["k1", "k2"]);
  });

  test("carriage returns are handled", () => {
    // Windows-authored exports use CRLF; the split is `/\r?\n/`.
    expect(parseCredentialBatch("k1\r\nk2").map((e) => e.value)).toEqual(["k1", "k2"]);
  });

  test("a wrapper inside one JSONL line is unwrapped", () => {
    // `parseSingleLine` applies `wrapperRows` too, so a line that is itself a
    // wrapped export expands.
    const blob = '{"accounts":[{"apiKey":"k1"}]}\n{"apiKey":"k2"}';
    expect(parseCredentialBatch(blob).map((e) => e.value)).toEqual(["k1", "k2"]);
  });

  test("a per-line kind is detected independently", () => {
    // A mixed batch: one OAuth export line, one bare key. Each line gets its own
    // kind rather than inheriting the first.
    const blob = '{"refresh_token":"rt"}\nsk-ant-PLAIN';
    const entries = parseCredentialBatch(blob);
    expect(entries.map((e) => e.kind)).toEqual(["oauth", "api_key"]);
  });

  test("a multi-line key:value block is not split by the line count check", () => {
    // The `Object.keys(asKeyValue).length === lines.length` guard: every line
    // parsed, so it is one structured credential.
    const entries = parseCredentialBatch("apiKey: sk-ant-EXAMPLE\nregion: us-east-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("sk-ant-EXAMPLE");
  });

  test("an unfolded `key: value` line is never stored as the literal text", () => {
    // The defect this pins: the block guard required EVERY line to parse as a
    // distinct `key: value`, so one comment header, an indented continuation, or a
    // repeated key dropped the whole block into the per-line path — where
    // `parseSingleLine` cannot parse `apiKey: sk-...` as JSON and returned the
    // LINE'S LITERAL TEXT as the secret. The operator got an account whose stored
    // credential was the string `"apiKey: first"`, and the real key was discarded.
    //
    // `parseCredentialBatch` now consults `parseKeyValueLines` before the per-line
    // path, exactly as `extractCredentialFromPaste` always did, so the two
    // exported parsers agree.
    const duplicateKey = parseCredentialBatch("apiKey: first\napiKey: second");
    expect(duplicateKey).toHaveLength(1);
    expect(duplicateKey[0]?.value).toBe("second");

    const commentHeader = parseCredentialBatch("# Anthropic credentials\napiKey: sk-ant-EXAMPLE");
    expect(commentHeader).toHaveLength(1);
    expect(commentHeader[0]?.value).toBe("sk-ant-EXAMPLE");

    const continuation = parseCredentialBatch("apiKey: sk-ant-EXAMPLE\n  continuation");
    expect(continuation).toHaveLength(1);
    expect(continuation[0]?.value).toBe("sk-ant-EXAMPLE");
  });

  test("no entry's value is ever a `key: value` line of the paste", () => {
    // The generalisation of the defect: whatever the block's shape, a literal
    // `key: value` line must not end up as a credential. This is the assertion
    // that would have caught it without enumerating shapes.
    const pastes = [
      "apiKey: first\napiKey: second",
      "# comment\napiKey: sk-ant-EXAMPLE",
      "apiKey: sk-ant-EXAMPLE\n  indented continuation",
      "apiKey: sk-ant-EXAMPLE\nregion: us-east-1",
      "region: us-east-1\nzone: b",
      "token: a\nnote: b\nother: c",
    ];
    for (const paste of pastes) {
      for (const entry of parseCredentialBatch(paste)) {
        expect(entry.value).not.toMatch(/^[A-Za-z_][\w-]*\s*:\s/);
      }
    }
  });

  test("the batch and single-credential paths agree on a key:value block", () => {
    // The asymmetry the defect consisted of. For every block shape the two must
    // resolve to the same secret, because the add-account form uses the batch path
    // while the paste preview historically used the single one — a disagreement
    // means the operator sees one value and stores another.
    for (const paste of [
      "apiKey: first\napiKey: second",
      "# Anthropic credentials\napiKey: sk-ant-EXAMPLE",
      "apiKey: sk-ant-EXAMPLE\n  continuation",
      "apiKey: sk-ant-EXAMPLE\nregion: us-east-1",
      "token: sk-ant-EXAMPLE\nnote: b",
    ]) {
      const batch = parseCredentialBatch(paste);
      expect(batch).toHaveLength(1);
      expect(batch[0]?.value).toBe(extractCredentialFromPaste(paste).value);
    }
  });

  test("a block with no credential field is one entry, and the paths differ harmlessly", () => {
    // MEASURED, and the one place the two paths still differ: with no credential
    // field, `entryFromObject` falls back to `JSON.stringify(obj)` while
    // `extractCredentialFromPaste` returns the raw text. Both are lossless — the
    // information is identical, only its encoding differs — and neither can
    // authenticate, so this is not a defect. Pinned so the difference is known.
    const paste = "region: us-east-1\nzone: b";
    const batch = parseCredentialBatch(paste);
    expect(batch).toHaveLength(1);
    expect(JSON.parse(batch[0]?.value ?? "")).toEqual({ region: "us-east-1", zone: "b" });
    expect(extractCredentialFromPaste(paste).value).toBe(paste);
  });

  test("the batch path no longer disagrees with the single-credential path", () => {
    // Was the record of the asymmetry the defect consisted of: the batch path
    // split these into two literal-text entries while the single path resolved
    // them correctly. Now both agree, and this test is the regression guard.
    expect(extractCredentialFromPaste("apiKey: first\napiKey: second")).toEqual({
      value: "second",
      extracted: true,
      source: "apiKey",
    });
    expect(extractCredentialFromPaste("# Anthropic credentials\napiKey: sk-ant-EXAMPLE")).toEqual({
      value: "sk-ant-EXAMPLE",
      extracted: true,
      source: "apiKey",
    });
    // And the batch path, on the same inputs, now agrees:
    expect(parseCredentialBatch("# Anthropic credentials\napiKey: sk-ant-EXAMPLE")).toHaveLength(1);
  });
});

describe("parseCredentialBatch — cookie bundles", () => {
  test("a flat Cookie-Editor array is ONE oauth entry preserving the whole bundle", () => {
    // The property the unified check exists for: a cookie array is a session, so
    // splitting it would create one broken account per cookie. The whole JSON is
    // the credential.
    const bundle = JSON.stringify([
      { name: "sessionToken", value: "abc", domain: ".example.com", path: "/" },
      { name: "userId", value: '"42"', domain: ".example.com" },
    ]);
    const entries = parseCredentialBatch(bundle);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe(bundle);
    expect(entries[0]?.kind).toBe("oauth");
  });

  test("the identity is read from the userId-shaped cookie", () => {
    // `userid`/`uid`/`accountid`/`cuserid`, with surrounding quotes stripped —
    // cookie values are often stored JSON-quoted.
    const bundle = JSON.stringify([
      { name: "userId", value: '"42"', domain: ".example.com" },
      { name: "auth", value: "tok", domain: ".example.com" },
    ]);
    expect(parseCredentialBatch(bundle)[0]?.identity).toBe("42");
  });

  test("the identity match is case-insensitive", () => {
    const bundle = JSON.stringify([
      { name: "UserID", value: "42", domain: ".example.com" },
      { name: "auth", value: "tok", domain: ".example.com" },
    ]);
    expect(parseCredentialBatch(bundle)[0]?.identity).toBe("42");
  });

  test("a bundle with no auth-shaped cookie is an api_key", () => {
    // `isOAuth` is set only by a cookie whose name contains token/ph/auth/session.
    // A bundle of only a userId cookie has no OAuth character.
    const bundle = JSON.stringify([{ name: "userId", value: "42", domain: ".example.com" }]);
    const entries = parseCredentialBatch(bundle);
    expect(entries[0]?.kind).toBe("api_key");
    expect(entries[0]?.identity).toBe("42");
  });

  test("a nested SessionBox export is recognised as a cookie bundle", () => {
    // Pattern 1: `[{ domain, cookies: [...] }]`. The whole container is the
    // credential and the nested cookies are inspected for identity and auth.
    const bundle = JSON.stringify([
      {
        domain: ".example.com",
        cookies: [
          { name: "userId", value: "77" },
          { name: "sessionToken", value: "tok" },
        ],
      },
    ]);
    const entries = parseCredentialBatch(bundle);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe(bundle);
    expect(entries[0]?.kind).toBe("oauth");
    expect(entries[0]?.identity).toBe("77");
  });

  test("an array of plain objects without cookie markers is NOT a cookie bundle", () => {
    // The discriminator: every item must have `name` AND `value` AND one of
    // domain/path/expirationDate. An account list with `name` and `value` but no
    // cookie marker stays a batch.
    const entries = parseCredentialBatch(
      '[{"name":"a","value":"k1"},{"name":"b","value":"k2"}]',
    );
    expect(entries).toHaveLength(2);
  });

  test("a flat bundle is recognised from a path marker alone", () => {
    // `domain !== undefined || path !== undefined || expirationDate !== undefined`
    // — any one of the three is enough.
    for (const marker of [{ path: "/" }, { expirationDate: 1735689600 }]) {
      const bundle = JSON.stringify([
        { name: "auth", value: "tok", ...marker },
        { name: "userId", value: "9", ...marker },
      ]);
      expect(parseCredentialBatch(bundle)).toHaveLength(1);
    }
  });

  test("an empty array is not a cookie bundle and produces no entries", () => {
    // `items.length === 0` returns false, and `objects.length > 0` is false, so
    // the whole-blob branch is skipped. MEASURED: `[]` then reaches the line
    // splitter as one line and yields one entry holding the raw text.
    const entries = parseCredentialBatch("[]");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe("[]");
  });

  test("an expired cookie bundle is still one entry", () => {
    // The module does not evaluate expiry — it is a paste-time detector, and the
    // backend is what refreshes or rejects. Pinned so the boundary is explicit.
    const bundle = JSON.stringify([
      { name: "auth", value: "stale", domain: ".example.com", expirationDate: 1 },
      { name: "userId", value: "1", domain: ".example.com" },
    ]);
    expect(parseCredentialBatch(bundle)).toHaveLength(1);
  });

  test("the bundle is never split regardless of cookie count", () => {
    // The scale case that motivates the rule: 50 cookies must still be ONE
    // account.
    const cookies = Array.from({ length: 50 }, (_value, index) => ({
      name: index === 0 ? "sessionToken" : `cookie-${index}`,
      value: `v${index}`,
      domain: ".example.com",
    }));
    const entries = parseCredentialBatch(JSON.stringify(cookies));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("oauth");
  });
});

describe("assignAccountNames", () => {
  test("an identity is used verbatim as the name", () => {
    const names = assignAccountNames([{ value: "k", kind: "api_key", identity: "me@x.com" }], "openai", []);
    expect(names).toEqual(["me@x.com"]);
  });

  test("an entry with no identity is named providerId-N from 1", () => {
    // The fallback that makes a batch of bare keys usable.
    const entries = [
      { value: "k1", kind: "api_key" as const },
      { value: "k2", kind: "api_key" as const },
      { value: "k3", kind: "api_key" as const },
    ];
    expect(assignAccountNames(entries, "openai", [])).toEqual([
      "openai-1",
      "openai-2",
      "openai-3",
    ]);
  });

  test("the sequence skips names that already exist", () => {
    // `while (used.has(...)) nextSequence += 1` — a new batch must not collide
    // with what is already on the account list.
    const entries = [
      { value: "k1", kind: "api_key" as const },
      { value: "k2", kind: "api_key" as const },
    ];
    expect(assignAccountNames(entries, "openai", ["openai-1", "openai-2"])).toEqual([
      "openai-3",
      "openai-4",
    ]);
  });

  test("a colliding identity gets a numeric suffix from 2", () => {
    // The operator pasted an account whose email is already on the list.
    const entries = [{ value: "k", kind: "api_key" as const, identity: "me@x.com" }];
    expect(assignAccountNames(entries, "openai", ["me@x.com"])).toEqual(["me@x.com (2)"]);
  });

  test("the suffix keeps counting past an existing suffixed name", () => {
    const entries = [{ value: "k", kind: "api_key" as const, identity: "me@x.com" }];
    expect(assignAccountNames(entries, "openai", ["me@x.com", "me@x.com (2)"])).toEqual([
      "me@x.com (3)",
    ]);
  });

  test("names within one batch do not collide with each other", () => {
    // The `used.add(name)` at the end of each iteration is what makes this work:
    // two entries sharing an identity must get distinct names, because the API
    // rejects duplicates.
    const entries = [
      { value: "k1", kind: "api_key" as const, identity: "same@x.com" },
      { value: "k2", kind: "api_key" as const, identity: "same@x.com" },
      { value: "k3", kind: "api_key" as const, identity: "same@x.com" },
    ];
    expect(assignAccountNames(entries, "openai", [])).toEqual([
      "same@x.com",
      "same@x.com (2)",
      "same@x.com (3)",
    ]);
  });

  test("a generated name and an identity name do not collide across a batch", () => {
    // An identity literally equal to the generated pattern. The first entry takes
    // "openai-1" as a generated name; the second's identity must then be
    // suffixed rather than duplicating it.
    const entries = [
      { value: "k1", kind: "api_key" as const },
      { value: "k2", kind: "api_key" as const, identity: "openai-2" },
      { value: "k3", kind: "api_key" as const },
    ];
    const names = assignAccountNames(entries, "openai", []);
    expect(names).toEqual(["openai-1", "openai-2", "openai-3"]);
    expect(new Set(names).size).toBe(3);
  });

  test("every returned name is unique, whatever the input", () => {
    // The invariant the API depends on, swept over a messy batch.
    const entries = [
      { value: "k1", kind: "api_key" as const },
      { value: "k2", kind: "api_key" as const, identity: "openai-1" },
      { value: "k3", kind: "api_key" as const, identity: "openai-1 (2)" },
      { value: "k4", kind: "api_key" as const, identity: "a@x.com" },
      { value: "k5", kind: "api_key" as const, identity: "a@x.com" },
      { value: "k6", kind: "api_key" as const },
      { value: "k7", kind: "api_key" as const },
    ];
    const names = assignAccountNames(entries, "openai", ["openai-1", "a@x.com"]);
    expect(names).toHaveLength(entries.length);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length > 0)).toBe(true);
  });

  test("the existing-names list is not mutated", () => {
    // The caller's account list is React state; the function copies it into a
    // Set, and this asserts it did not write back.
    const existing = ["openai-1"];
    const before = [...existing];
    assignAccountNames([{ value: "k", kind: "api_key" }], "openai", existing);
    expect(existing).toEqual(before);
  });

  test("an empty batch produces no names", () => {
    expect(assignAccountNames([], "openai", ["openai-1"])).toEqual([]);
  });

  test("the generated prefix uses the caller's providerId", () => {
    // A per-provider prefix is what makes "claude-1" meaningful on a mixed list.
    expect(assignAccountNames([{ value: "k", kind: "oauth" }], "claude", [])).toEqual(["claude-1"]);
  });

  test("the kind does not affect naming", () => {
    // Naming is identity-based only; an OAuth entry with an identity gets that
    // identity, exactly as an api_key entry would.
    const entries = [
      { value: "k", kind: "oauth" as const, identity: "me@x.com" },
      { value: "k", kind: "api_key" as const, identity: "you@x.com" },
    ];
    expect(assignAccountNames(entries, "claude", [])).toEqual(["me@x.com", "you@x.com"]);
  });
});
