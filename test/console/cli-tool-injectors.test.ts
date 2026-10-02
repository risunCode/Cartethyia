/**
 * The CLI-tool config injector: structured text editing and the file lifecycle.
 *
 * `fs-ops.ts` is what every injector uses to rewrite a user's own config file —
 * `~/.codex/config.toml`, `~/.claude/settings.json`, and a dozen more. The
 * module deliberately is *not* a TOML parser: it preserves the author's
 * comments and formatting by upserting and removing through line-oriented
 * regexes. That choice is the whole risk surface, and this suite attacks it.
 *
 * The defects pinned here all shared one root cause and all produced
 * **syntactically invalid TOML**, which the target CLI then refuses to start
 * on — a silent, total breakage of the tool the operator was configuring:
 *
 * - `\\s` in a line-oriented pattern matches a **newline**, and several of
 *   these patterns drive a `replace` whose replacement carries no trailing
 *   break, so the match swallowed the break and glued two lines together.
 *   Measured: `[agents]\n\n  k = "1"` upserted to `[agents]  k = "9"`, and
 *   `model = "gpt-5"\n\n[section]` to `model = "new"[section]`.
 * - A removal that took `\\s*` after the value also ate the *next* line's
 *   indentation, collapsing the blank lines that separate sections.
 * - `ensureV1Suffix` appended to a URL that already ended in `/`, so an
 *   endpoint typed as `http://host:12800/` became `http://host:12800//v1`.
 * - `isLocalEndpoint` scanned the whole URL as a substring, so
 *   `https://notlocalhost.com` and `https://evil.com/localhost` both read as
 *   *this* gateway — and that value is what the dashboard shows the operator.
 *
 * The last block drives the real `codex` injector end to end against a temp
 * `HOME`, because the unit-level guarantees only matter if the composed
 * apply → status → reset lifecycle holds: a reset must leave the user's
 * original file semantically intact.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDir,
  ensureV1Suffix,
  isLocalEndpoint,
  keyPrefix,
  readJsonFile,
  readTextFile,
  stripV1Suffix,
  textGet,
  textHas,
  textRemove,
  textUpsert,
  writeJsonFile,
  writeTextFile,
  type TextSelector,
} from "../../src/console/cli-tools/fs-ops";

/** True when a header and a key ended up on one line, which TOML forbids. */
function hasGluedHeader(text: string): boolean {
  return /^\[[^\]]*\][ \t]*\S/m.test(text);
}

/** True when a value ran into the next header, which TOML forbids. */
function hasGluedValue(text: string): boolean {
  return /"[ \t]*\[/m.test(text);
}

describe("ensureV1Suffix", () => {
  test("appends the suffix to a bare origin", () => {
    expect(ensureV1Suffix("http://localhost:12800")).toBe("http://localhost:12800/v1");
  });

  test("leaves an endpoint that already ends in /v1 alone", () => {
    expect(ensureV1Suffix("http://localhost:12800/v1")).toBe("http://localhost:12800/v1");
  });

  test("normalizes a trailing slash instead of doubling it", () => {
    // The defect: `url.endsWith("/v1")` is false for `.../`, so the suffix was
    // appended to the slash and produced `//v1` — a different path, and a 404
    // from every downstream client. This is the form a browser address bar and
    // the dashboard's own links produce.
    expect(ensureV1Suffix("http://localhost:12800/")).toBe("http://localhost:12800/v1");
    expect(ensureV1Suffix("http://localhost:12800/v1/")).toBe("http://localhost:12800/v1");
    expect(ensureV1Suffix("http://localhost:12800/v1//")).toBe("http://localhost:12800/v1");
  });

  test("never emits a doubled slash for any trailing-slash count", () => {
    for (const suffix of ["", "/", "//", "///"]) {
      expect(ensureV1Suffix(`http://host:1${suffix}`)).toBe("http://host:1/v1");
    }
  });

  test("does not touch a path that merely ends in something else", () => {
    expect(ensureV1Suffix("http://host:1/API")).toBe("http://host:1/API/v1");
  });

  test("an empty input still yields the suffix", () => {
    // Degenerate, but it is what the arithmetic does; the console validates the
    // endpoint before this point, so an empty value never reaches it.
    expect(ensureV1Suffix("")).toBe("/v1");
  });

  test("a root path keeps exactly one slash", () => {
    expect(ensureV1Suffix("http://host/")).toBe("http://host/v1");
  });
});

describe("stripV1Suffix", () => {
  test("removes a trailing /v1", () => {
    expect(stripV1Suffix("http://host:1/v1")).toBe("http://host:1");
  });

  test("leaves a URL without the suffix alone", () => {
    expect(stripV1Suffix("http://host:1")).toBe("http://host:1");
  });

  test("normalizes a trailing slash rather than returning one", () => {
    expect(stripV1Suffix("http://host:1/v1/")).toBe("http://host:1");
    expect(stripV1Suffix("http://host:1/")).toBe("http://host:1");
  });

  test("is the inverse of ensureV1Suffix for a bare origin", () => {
    const origin = "http://host:1";
    expect(stripV1Suffix(ensureV1Suffix(origin))).toBe(origin);
  });

  test("an empty input stays empty", () => {
    expect(stripV1Suffix("")).toBe("");
  });
});

describe("isLocalEndpoint", () => {
  test("recognizes the local spellings an operator actually types", () => {
    for (const url of [
      "http://localhost:12800",
      "http://localhost",
      "http://127.0.0.1:12800",
      "http://127.0.0.1",
      "http://0.0.0.0:12800",
      "http://[::1]:12800",
    ]) {
      expect(isLocalEndpoint(url)).toBe(true);
    }
  });

  test("recognizes a Cartethyia hostname", () => {
    expect(isLocalEndpoint("https://cartethyia.example.com")).toBe(true);
    expect(isLocalEndpoint("https://CARTETHYIA.io")).toBe(true);
  });

  test("accepts a bare host:port with no scheme", () => {
    expect(isLocalEndpoint("localhost:12800")).toBe(true);
  });

  test("a hostname that merely contains a local word is not local", () => {
    // The defect: an unanchored substring test matched anywhere in the string.
    // `configured` is what the dashboard shows the operator, so a tool pointed
    // at a remote host read as pointed at this gateway.
    for (const url of [
      "https://notlocalhost.com",
      "https://mylocalhostproxy.net",
      "https://LOCALHOST.example",
      "https://my-cartethyia-clone.io",
    ]) {
      expect(isLocalEndpoint(url)).toBe(false);
    }
  });

  test("a local word in the path or query is not local", () => {
    for (const url of [
      "https://evil.com/localhost",
      "https://evil.com/?next=localhost",
      "https://x.com/cartethyia-fake",
    ]) {
      expect(isLocalEndpoint(url)).toBe(false);
    }
  });

  test("a 127.x address is local, and a lookalike is not", () => {
    expect(isLocalEndpoint("http://127.0.0.1:1")).toBe(true);
    expect(isLocalEndpoint("http://127.5.5.5:1")).toBe(true);
    // `1270.0.0.1` is not a 127/8 address; a `startsWith("127")` test would
    // wrongly accept it.
    expect(isLocalEndpoint("http://1270.0.0.1:1")).toBe(false);
  });

  test("a public address is not local", () => {
    expect(isLocalEndpoint("https://api.openai.com")).toBe(false);
  });

  test("absent and unparseable values are not local", () => {
    for (const url of [null, undefined, "", "not a url at all"]) {
      expect(isLocalEndpoint(url)).toBe(false);
    }
  });

  test("credentials in the URL do not change the verdict", () => {
    expect(isLocalEndpoint("http://user:pass@localhost:12800")).toBe(true);
    expect(isLocalEndpoint("http://user:pass@notlocalhost.com")).toBe(false);
  });
});

describe("keyPrefix", () => {
  test("truncates a key longer than eight characters", () => {
    // The full secret must never reach the browser; only this prefix does.
    expect(keyPrefix("sk-ant-api03-abcdefghij")).toBe("sk-ant-a...");
  });

  test("a key of exactly eight characters is truncated too", () => {
    expect(keyPrefix("12345678")).toBe("12345678...");
  });

  test("a key shorter than eight characters is returned whole", () => {
    // Too short to leak anything useful, and truncating it would make the
    // operator's own key unrecognizable to them.
    expect(keyPrefix("short")).toBe("short");
    expect(keyPrefix("1234567")).toBe("1234567");
  });

  test("absent and empty values pass through as null or empty", () => {
    expect(keyPrefix(null)).toBeNull();
    expect(keyPrefix(undefined)).toBeNull();
    expect(keyPrefix("")).toBe("");
  });
});

describe("textGet: root keys", () => {
  const TOML = `# comment\nmodel = "old-model"\nother = "keep"\n\n[provider]\n  name = "openai"\n`;

  test("reads a root key's value", () => {
    expect(textGet(TOML, { kind: "flat", key: "model" })).toBe("old-model");
  });

  test("returns null for an absent key", () => {
    expect(textGet(TOML, { kind: "flat", key: "missing" })).toBeNull();
  });

  test("does not read a key that lives inside a section", () => {
    // The distinction the codex status defect turned on: a root read must not
    // silently pick up a section's key.
    expect(textGet(TOML, { kind: "flat", key: "name" })).toBeNull();
  });

  test("reads an env-style line", () => {
    expect(textGet("FOO=bar\n", { kind: "flat", key: "FOO", format: "env" })).toBe("bar");
  });

  test("trims an env value", () => {
    expect(textGet("FOO=  bar  \n", { kind: "flat", key: "FOO", format: "env" })).toBe("bar");
  });

  test("keeps spaces inside an env value", () => {
    expect(textGet("BAZ=qux with spaces\n", { kind: "flat", key: "BAZ", format: "env" })).toBe(
      "qux with spaces",
    );
  });

  test("does not let a key match a longer key that starts the same way", () => {
    // `^model` without an anchor at the `=` would match `model_provider`.
    const text = `model_provider = "openai"\n`;
    expect(textGet(text, { kind: "flat", key: "model" })).toBeNull();
    expect(textGet(text, { kind: "flat", key: "model_provider" })).toBe("openai");
  });

  test("does not match a commented-out key", () => {
    // The `^` anchor plus the `m` flag is what keeps `# model = "x"` out; a
    // config the operator deliberately commented out must read as unset.
    expect(textGet(`# model = "x"\n`, { kind: "flat", key: "model" })).toBeNull();
  });
});

describe("textGet: section keys", () => {
  const TOML = `[provider]\n  name = "openai"\n  base = "https://x"\n\n[other]\n  name = "y"\n`;

  test("reads a key from the named section", () => {
    expect(textGet(TOML, { kind: "sectionKey", section: "provider", key: "name" })).toBe("openai");
  });

  test("reads the right section when two share a key name", () => {
    expect(textGet(TOML, { kind: "sectionKey", section: "other", key: "name" })).toBe("y");
  });

  test("returns null for a key the section does not have", () => {
    expect(textGet(TOML, { kind: "sectionKey", section: "provider", key: "nope" })).toBeNull();
  });

  test("returns null for a section that does not exist", () => {
    expect(textGet(TOML, { kind: "sectionKey", section: "absent", key: "name" })).toBeNull();
  });

  test("does not read a root key through a section selector", () => {
    const text = `name = "root"\n\n[provider]\n  name = "inner"\n`;
    expect(textGet(text, { kind: "sectionKey", section: "provider", key: "name" })).toBe("inner");
  });

  test("does not read across a section boundary", () => {
    // `[provider]` has no `later`; the key belongs to the next section. A
    // bounds computation that ran to end-of-file would wrongly return it.
    const text = `[provider]\n  a = "1"\n\n[other]\n  later = "2"\n`;
    expect(textGet(text, { kind: "sectionKey", section: "provider", key: "later" })).toBeNull();
  });

  test("reads a dotted section name, which codex uses for provider tables", () => {
    const text = `[model_providers.cartethyia]\n  base_url = "http://localhost:12800/v1"\n`;
    expect(
      textGet(text, {
        kind: "sectionKey",
        section: "model_providers.cartethyia",
        key: "base_url",
      }),
    ).toBe("http://localhost:12800/v1");
  });

  test("a section name is matched literally, not as a pattern", () => {
    // The name is escaped before it enters the regex; a dotted name would
    // otherwise match any character in the dot's place.
    const text = `[a.b]\n  k = "1"\n[aXb]\n  k = "2"\n`;
    expect(textGet(text, { kind: "sectionKey", section: "a.b", key: "k" })).toBe("1");
  });
});

describe("textGet: whole sections", () => {
  test("returns the body between the header and the next header", () => {
    const text = `[a]\n  x = "1"\n\n[b]\n  y = "2"\n`;
    expect(textGet(text, { kind: "section", section: "a" })).toBe(`\n  x = "1"\n\n`);
  });

  test("returns the body to end-of-file for the last section", () => {
    const text = `[a]\n  x = "1"\n`;
    expect(textGet(text, { kind: "section", section: "a" })).toBe(`\n  x = "1"\n`);
  });

  test("returns null for an absent section", () => {
    expect(textGet(`[a]\n`, { kind: "section", section: "b" })).toBeNull();
  });
});

describe("textHas", () => {
  test("agrees with textGet for every selector kind", () => {
    const text = `root = "1"\n\n[a]\n  k = "2"\n`;
    const selectors: ReadonlyArray<TextSelector> = [
      { kind: "flat", key: "root" },
      { kind: "flat", key: "absent" },
      { kind: "sectionKey", section: "a", key: "k" },
      { kind: "sectionKey", section: "a", key: "absent" },
      { kind: "section", section: "a" },
      { kind: "section", section: "absent" },
    ];
    for (const selector of selectors) {
      expect(textHas(text, selector)).toBe(textGet(text, selector) !== null);
    }
  });

  test("does not report a commented-out key as present", () => {
    expect(textHas(`# model = "x"\n`, { kind: "flat", key: "model" })).toBe(false);
  });
});

describe("textUpsert: root keys", () => {
  test("replaces an existing root key in place, keeping the comment above it", () => {
    const text = `# mine\nmodel = "old"\nother = "keep"\n`;
    expect(textUpsert(text, { kind: "flat", key: "model" }, "new")).toBe(
      `# mine\nmodel = "new"\nother = "keep"\n`,
    );
  });

  test("appends a new root key at end-of-file", () => {
    const text = `model = "old"\n`;
    expect(textUpsert(text, { kind: "flat", key: "brandnew" }, "v")).toBe(
      `model = "old"\nbrandnew = "v"\n`,
    );
  });

  test("adds a newline before appending when the file does not end with one", () => {
    expect(textUpsert(`model = "old"`, { kind: "flat", key: "brandnew" }, "v")).toBe(
      `model = "old"\nbrandnew = "v"\n`,
    );
  });

  test("appends to an empty file without a leading blank", () => {
    expect(textUpsert("", { kind: "flat", key: "k" }, "v")).toBe(`k = "v"\n`);
  });

  test("does not match a longer key that shares the prefix", () => {
    const text = `model_provider = "openai"\n`;
    expect(textUpsert(text, { kind: "flat", key: "model" }, "new")).toBe(
      `model_provider = "openai"\nmodel = "new"\n`,
    );
  });

  test("env format replaces in place and appends without quotes", () => {
    expect(textUpsert(`FOO=bar\nBAZ=q\n`, { kind: "flat", key: "FOO", format: "env" }, "new")).toBe(
      `FOO=new\nBAZ=q\n`,
    );
    expect(textUpsert(`FOO=bar\n`, { kind: "flat", key: "NEW", format: "env" }, "v")).toBe(
      `FOO=bar\nNEW=v\n`,
    );
  });

  test("env format adds the separating newline only when needed", () => {
    expect(textUpsert(`FOO=bar`, { kind: "flat", key: "NEW", format: "env" }, "v")).toBe(
      `FOO=bar\nNEW=v\n`,
    );
  });

  test("env format on an empty file emits just the line", () => {
    expect(textUpsert("", { kind: "flat", key: "NEW", format: "env" }, "v")).toBe(`NEW=v\n`);
  });
});

describe("textUpsert: insertAtTop", () => {
  test("inserts a new root key before the first section header", () => {
    // TOML requires root keys to precede every table; appending at end-of-file
    // would put the key inside the last section instead. The blank line stays
    // with the header, which is what it was separating.
    const text = `model = "m"\n\n[a]\n  k = "v"\n`;
    expect(textUpsert(text, { kind: "flat", key: "brandnew", insertAtTop: true }, "v")).toBe(
      `model = "m"\nbrandnew = "v"\n\n[a]\n  k = "v"\n`,
    );
  });

  test("replaces an existing root key without gluing it to the next header", () => {
    // The defect, measured: `model = "gpt-5"\n\n[section]` came out as
    // `model = "new"[section]`. The `\\s*$` anchor in the key pattern matched
    // the blank line's newlines, and the replacement carried none of them back.
    const text = `model = "gpt-5"\n\n[section]\n  k = "v"\n`;
    const result = textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, "new");
    expect(result).toBe(`model = "new"\n\n[section]\n  k = "v"\n`);
    expect(hasGluedHeader(result)).toBe(false);
  });

  test("keeps the blank line between root keys and a section, whatever its width", () => {
    for (const gap of ["\n", "\n\n", "\n\n\n"]) {
      const text = `model = "old"${gap}[s]\n`;
      const result = textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, "new");
      expect(result).toBe(`model = "new"${gap}[s]\n`);
    }
  });

  test("keeps a comment above the replaced key", () => {
    const text = `# note\nmodel = "old"\n\n[s]\n`;
    expect(textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, "new")).toBe(
      `# note\nmodel = "new"\n\n[s]\n`,
    );
  });

  test("appends at end-of-file when the file has no section", () => {
    expect(textUpsert(`a = "1"\n`, { kind: "flat", key: "b", insertAtTop: true }, "2")).toBe(
      `a = "1"\nb = "2"\n`,
    );
  });

  test("adds the separating newline when the root region lacks one", () => {
    expect(textUpsert(`a = "1"`, { kind: "flat", key: "b", insertAtTop: true }, "2")).toBe(
      `a = "1"\nb = "2"\n`,
    );
  });

  test("inserts into an empty file with no leading newline", () => {
    expect(textUpsert("", { kind: "flat", key: "k", insertAtTop: true }, "v")).toBe(`k = "v"\n`);
  });

  test("replaces a root key in a file whose only section follows immediately", () => {
    const text = `model = "old"\n[s]\n`;
    expect(textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, "new")).toBe(
      `model = "new"\n[s]\n`,
    );
  });
});

describe("textUpsert: section keys", () => {
  test("replaces a key inside its section, leaving siblings alone", () => {
    const text = `[provider]\n  name = "openai"\n  base = "https://x"\n`;
    expect(textUpsert(text, { kind: "sectionKey", section: "provider", key: "name" }, "anthropic")).toBe(
      `[provider]\n  name = "anthropic"\n  base = "https://x"\n`,
    );
  });

  test("appends a new key to the end of the section body", () => {
    const text = `[provider]\n  name = "openai"\n`;
    expect(textUpsert(text, { kind: "sectionKey", section: "provider", key: "newkey" }, "v")).toBe(
      `[provider]\n  name = "openai"\n  newkey = "v"\n`,
    );
  });

  test("creates the section when it is absent", () => {
    const text = `model = "m"\n`;
    expect(textUpsert(text, { kind: "sectionKey", section: "agents", key: "k" }, "v")).toBe(
      `model = "m"\n[agents]\n  k = "v"\n`,
    );
  });

  test("creates the section in an empty file without a leading blank", () => {
    expect(textUpsert("", { kind: "sectionKey", section: "s", key: "k" }, "v")).toBe(
      `[s]\n  k = "v"\n`,
    );
  });

  test("does not glue the key onto the header when a blank line follows it", () => {
    // The defect, measured: a body of `\n\n  k = "1"\n` upserted to
    // `[agents]  k = "9"`. The `^\\s*` prefix in the key pattern matched the
    // header's break and the blank line, and the replacement began with the
    // indented key — so the key landed on the header's line. TOML rejects that
    // outright, and `textGet` then read the key back as null.
    const text = `[agents]\n\n  k = "1"\n  other = "2"\n`;
    const result = textUpsert(text, { kind: "sectionKey", section: "agents", key: "k" }, "9");
    expect(result).toBe(`[agents]\n\n  k = "9"\n  other = "2"\n`);
    expect(hasGluedHeader(result)).toBe(false);
    expect(textGet(result, { kind: "sectionKey", section: "agents", key: "k" })).toBe("9");
  });

  test("keeps the next section header on its own line", () => {
    // The defect, measured: the last key of a section followed immediately by
    // the next header came out as `other = "9"[z]`.
    const text = `[agents]\n  k = "1"\n  other = "2"\n[z]\n`;
    const result = textUpsert(text, { kind: "sectionKey", section: "agents", key: "other" }, "9");
    expect(result).toBe(`[agents]\n  k = "1"\n  other = "9"\n[z]\n`);
    expect(hasGluedValue(result)).toBe(false);
  });

  test("preserves a blank line inside the section body", () => {
    const text = `[agents]\n  k = "1"\n\n  other = "2"\n`;
    expect(textUpsert(text, { kind: "sectionKey", section: "agents", key: "other" }, "9")).toBe(
      `[agents]\n  k = "1"\n\n  other = "9"\n`,
    );
  });

  test("recovers a file where a previous buggy write glued the key to the header", () => {
    // The malformed branch exists precisely so an already-broken config heals
    // on the next apply rather than staying broken forever.
    const text = `[provider]  name = "x"\n  base = "https://y"\n`;
    const result = textUpsert(text, { kind: "sectionKey", section: "provider", key: "name" }, "z");
    expect(result).toBe(`[provider]\n  name = "z"\n\n  base = "https://y"\n`);
    expect(hasGluedHeader(result)).toBe(false);
  });

  test("does not treat another section's key as this section's", () => {
    const text = `[a]\n  x = "1"\n\n[b]\n  x = "2"\n`;
    expect(textUpsert(text, { kind: "sectionKey", section: "a", key: "x" }, "9")).toBe(
      `[a]\n  x = "9"\n\n[b]\n  x = "2"\n`,
    );
  });
});

describe("textUpsert: whole sections", () => {
  test("replaces a section body in place", () => {
    const text = `# top\n[a]\n  x = "1"\n\n[b]\n  y = "2"\n`;
    expect(textUpsert(text, { kind: "section", section: "a" }, `  x = "9"`)).toBe(
      `# top\n[a]\n  x = "9"\n\n[b]\n  y = "2"\n`,
    );
  });

  test("does not swallow the following section", () => {
    const text = `[a]\n  x = "1"\n[b]\n  y = "2"\n`;
    const result = textUpsert(text, { kind: "section", section: "a" }, `  x = "9"`);
    expect(result).toContain(`[b]\n  y = "2"`);
  });

  test("appends a section that does not exist yet", () => {
    const text = `model = "m"\n\n[a]\n  x = "1"\n`;
    expect(textUpsert(text, { kind: "section", section: "brandnew" }, `  y = "2"`)).toBe(
      `model = "m"\n\n[a]\n  x = "1"\n[brandnew]\n  y = "2"\n`,
    );
  });

  test("a dotted section name is matched literally", () => {
    const text = `[a.b]\n  k = "1"\n[aXb]\n  k = "2"\n`;
    expect(textUpsert(text, { kind: "section", section: "a.b" }, `  k = "9"`)).toBe(
      `[a.b]\n  k = "9"\n[aXb]\n  k = "2"\n`,
    );
  });
});

describe("textRemove", () => {
  test("removes a root key without touching the blank lines around it", () => {
    // The defect, measured: a removal took `\\s*` after the value, which ate the
    // blank line *and* the next line's indentation, collapsing the file's
    // paragraphing. The blank line is the author's, not the key's.
    const text = `model_provider = "openai"\n\n[model_providers.openai]\n  name = "OpenAI"\n`;
    expect(textRemove(text, { kind: "flat", key: "model_provider" })).toBe(
      `\n[model_providers.openai]\n  name = "OpenAI"\n`,
    );
  });

  test("does not consume the following line's indentation", () => {
    const text = `[p]\n  k = "1"\n  other = "2"\n`;
    // A root-level removal is deliberately not section-scoped, so a key that
    // sits inside a section is only matched when it is written unindented —
    // which is why this indented one is left alone. The guarantee that matters
    // is that the *sibling's* indentation is never eaten.
    const result = textRemove(text, { kind: "flat", key: "k" });
    expect(result).toBe(text);
    expect(result).toContain(`\n  other = "2"\n`);
  });

  test("removes an unindented key that sits inside a section", () => {
    const text = `[p]\nk = "1"\n  other = "2"\n`;
    expect(textRemove(text, { kind: "flat", key: "k" })).toBe(`[p]\n  other = "2"\n`);
  });

  test("removes every root occurrence, matching the module's stated scope", () => {
    const text = `m = "1"\nkeep = "k"\nm = "2"\n`;
    expect(textRemove(text, { kind: "flat", key: "m" })).toBe(`keep = "k"\n`);
  });

  test("removes an env line", () => {
    expect(textRemove(`FOO=bar\nBAZ=q\n`, { kind: "flat", key: "FOO", format: "env" })).toBe(
      `BAZ=q\n`,
    );
  });

  test("removes a section key and keeps the next key on its own line", () => {
    // The defect, measured: `[p]\n  a = "1"\n  b = "2"\n` became
    // `[p]b = "2"\n` — the header and the surviving key on one line, which TOML
    // rejects.
    const text = `[p]\n  a = "1"\n  b = "2"\n`;
    const result = textRemove(text, { kind: "sectionKey", section: "p", key: "a" });
    expect(result).toBe(`[p]\n  b = "2"\n`);
    expect(hasGluedHeader(result)).toBe(false);
  });

  test("removes the last section key and leaves the header", () => {
    const text = `[p]\n  a = "1"\n  b = "2"\n`;
    expect(textRemove(text, { kind: "sectionKey", section: "p", key: "b" })).toBe(`[p]\n  a = "1"\n`);
  });

  test("removing the only section key leaves a bare header", () => {
    expect(textRemove(`[p]\n  a = "1"\n`, { kind: "sectionKey", section: "p", key: "a" })).toBe(
      `[p]\n`,
    );
  });

  test("preserves a blank line inside the section body", () => {
    const text = `[agents]\n  k = "1"\n\n  other = "2"\n`;
    expect(textRemove(text, { kind: "sectionKey", section: "agents", key: "other" })).toBe(
      `[agents]\n  k = "1"\n\n`,
    );
  });

  test("removing an absent key is a no-op", () => {
    const text = `model = "m"\n\n[a]\n  k = "v"\n`;
    expect(textRemove(text, { kind: "flat", key: "nope" })).toBe(text);
    expect(textRemove(text, { kind: "sectionKey", section: "a", key: "nope" })).toBe(text);
    expect(textRemove(text, { kind: "sectionKey", section: "absent", key: "k" })).toBe(text);
  });

  test("removes a whole section without taking the next one", () => {
    const text = `[a]\n  x = "1"\n\n[b]\n  y = "2"\n`;
    expect(textRemove(text, { kind: "section", section: "a" })).toBe(`[b]\n  y = "2"\n`);
  });

  test("removes the last section", () => {
    expect(textRemove(`[a]\n  x = "1"\n\n[b]\n  y = "2"\n`, { kind: "section", section: "b" })).toBe(
      `[a]\n  x = "1"\n`,
    );
  });

  test("removing a section at the top drops the blank lines it left behind", () => {
    // Otherwise the file begins with, or ends in, empty lines where a section
    // used to be. Measured before the fix: `# top\n\n\n[a]\n  x = "1"\n` came
    // back as `# top\n\n\n` — three trailing blanks.
    expect(textRemove(`\n[a]\n  x = "1"\n`, { kind: "section", section: "a" })).toBe("");
    expect(textRemove(`# top\n\n\n[a]\n  x = "1"\n`, { kind: "section", section: "a" })).toBe(`# top\n`);
  });

  test("a gap between two surviving sections is preserved", () => {
    // Only the gap at the removal point is collapsed; the one separating the
    // remaining sections is the author's own formatting.
    const text = `[a]\n  x = "1"\n\n[b]\n  y = "2"\n\n[c]\n  z = "3"\n`;
    expect(textRemove(text, { kind: "section", section: "b" })).toBe(
      `[a]\n  x = "1"\n\n[c]\n  z = "3"\n`,
    );
  });

  test("a section name is matched literally, so a dotted name is safe", () => {
    const text = `[a.b]\n  k = "1"\n[aXb]\n  k = "2"\n`;
    expect(textRemove(text, { kind: "section", section: "a.b" })).toBe(`[aXb]\n  k = "2"\n`);
  });
});

describe("apply then reset leaves the user's file semantically intact", () => {
  const ORIGINAL = `# my codex config
model = "gpt-5"
model_provider = "openai"

[model_providers.openai]
  name = "OpenAI"
  base_url = "https://api.openai.com/v1"

[agents]
  default_subagent_model = "gpt-5-mini"
  other_agent_setting = "keep-me"
`;

  test("the composed edit sequence never produces invalid TOML", () => {
    // The exact sequence the codex injector performs, driven as one string so a
    // regression anywhere in it is caught here rather than only in the
    // end-to-end block below.
    let text = ORIGINAL;
    text = textRemove(text, { kind: "flat", key: "model" });
    text = textRemove(text, { kind: "flat", key: "review_model" });
    text = textRemove(text, { kind: "flat", key: "model_provider" });
    text = textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, "cartethyia-sonnet");
    text = textUpsert(text, { kind: "flat", key: "model_provider", insertAtTop: true }, "cartethyia");
    text = textUpsert(
      text,
      { kind: "section", section: "model_providers.cartethyia" },
      [`  name = "Cartethyia"`, `  base_url = "http://localhost:12800/v1"`].join("\n"),
    );
    text = textUpsert(
      text,
      { kind: "sectionKey", section: "agents", key: "default_subagent_model" },
      "cartethyia-haiku",
    );

    expect(hasGluedHeader(text)).toBe(false);
    expect(hasGluedValue(text)).toBe(false);
    expect(textGet(text, { kind: "flat", key: "model" })).toBe("cartethyia-sonnet");
    expect(textGet(text, { kind: "flat", key: "model_provider" })).toBe("cartethyia");
    expect(
      textGet(text, { kind: "sectionKey", section: "agents", key: "default_subagent_model" }),
    ).toBe("cartethyia-haiku");
    // The user's own unrelated content survives every edit.
    expect(text).toContain("# my codex config");
    expect(text).toContain("[model_providers.openai]");
    expect(text).toContain("other_agent_setting = \"keep-me\"");
  });

  test("the user's settings are still present after the reverse sequence", () => {
    let text = ORIGINAL;
    text = textUpsert(
      text,
      { kind: "sectionKey", section: "agents", key: "default_subagent_model" },
      "cartethyia-haiku",
    );
    text = textRemove(text, {
      kind: "sectionKey",
      section: "agents",
      key: "default_subagent_model",
    });
    text = textRemove(text, { kind: "section", section: "model_providers.cartethyia" });
    expect(hasGluedHeader(text)).toBe(false);
    expect(text).toContain("other_agent_setting = \"keep-me\"");
    expect(text).toContain("[model_providers.openai]");
    expect(text).not.toContain("default_subagent_model");
  });
});

describe("readJsonFile and writeJsonFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cartethyia-fsops-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a JSON object", async () => {
    const path = join(dir, "auth.json");
    await writeJsonFile(path, { key: "sk-ant-EXAMPLE" });
    expect(await readJsonFile(path)).toEqual({ key: "sk-ant-EXAMPLE" });
  });

  test("writes with two-space indentation, so the user can read the file", async () => {
    const path = join(dir, "auth.json");
    await writeJsonFile(path, { a: 1 });
    expect(await readTextFile(path)).toBe(`{\n  "a": 1\n}`);
  });

  test("tolerates a trailing comma, which hand-edited configs contain", async () => {
    const path = join(dir, "auth.json");
    await writeTextFile(path, `{\n  "a": 1,\n}`);
    expect(await readJsonFile(path)).toEqual({ a: 1 });
  });

  test("returns null for a missing file rather than throwing", async () => {
    expect(await readJsonFile(join(dir, "absent.json"))).toBeNull();
    expect(await readTextFile(join(dir, "absent.txt"))).toBeNull();
  });

  test("returns null for unparseable content rather than throwing", async () => {
    const path = join(dir, "broken.json");
    await writeTextFile(path, "{ not json");
    expect(await readJsonFile(path)).toBeNull();
  });

  test("a written file can be read back through readTextFile", async () => {
    const path = join(dir, "notes.txt");
    await writeTextFile(path, "hello");
    expect(await readTextFile(path)).toBe("hello");
  });

  test("ensureDir creates nested directories", async () => {
    const nested = join(dir, "a", "b", "c");
    await ensureDir(nested);
    const path = join(nested, "f.txt");
    await writeTextFile(path, "x");
    expect(await readTextFile(path)).toBe("x");
  });
});
