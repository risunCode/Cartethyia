import { describe, expect, test } from "bun:test";
import { textGet, textHas, textRemove, textUpsert } from "../../../src/console/cli-tools/fs-ops";

describe("textGet/textUpsert/textRemove/textHas — flat (toml)", () => {
  test("reads and upserts a quoted root-level key, preserving other content", () => {
    let text = 'model = "old"\nother = "keep"\n';
    expect(textGet(text, { kind: "flat", key: "model" })).toBe("old");
    text = textUpsert(text, { kind: "flat", key: "model" }, "new");
    expect(text).toContain('model = "new"');
    expect(text).toContain('other = "keep"');
  });

  test("appends a new flat key when absent", () => {
    const text = textUpsert("", { kind: "flat", key: "model" }, "gpt-5");
    expect(text.trim()).toBe('model = "gpt-5"');
  });

  test("removes every occurrence of a flat key", () => {
    const text = 'model = "a"\nother = "keep"\nmodel = "b"\n';
    const removed = textRemove(text, { kind: "flat", key: "model" });
    expect(removed).not.toContain("model");
    expect(removed).toContain('other = "keep"');
  });

  test("textHas reflects presence of a flat key", () => {
    expect(textHas('model = "x"', { kind: "flat", key: "model" })).toBe(true);
    expect(textHas('other = "x"', { kind: "flat", key: "model" })).toBe(false);
  });
});

describe("flat (env)", () => {
  test("reads and upserts unquoted KEY=VALUE, no trailing whitespace trim on write", () => {
    let text = "OPENAI_API_KEY=old\nOTHER=keep\n";
    expect(textGet(text, { kind: "flat", key: "OPENAI_API_KEY", format: "env" })).toBe("old");
    text = textUpsert(text, { kind: "flat", key: "OPENAI_API_KEY", format: "env" }, "new");
    expect(text).toContain("OPENAI_API_KEY=new");
    expect(text).toContain("OTHER=keep");
  });

  test("removes a single env key occurrence, not global", () => {
    const text = "A=1\nA=2\n";
    const removed = textRemove(text, { kind: "flat", key: "A", format: "env" });
    // Only the first line is removed — matches the original envRemove (non-global).
    expect(removed).toBe("A=2\n");
  });

  test("appends a new env key when file is empty", () => {
    const text = textUpsert("", { kind: "flat", key: "OPENAI_API_KEY", format: "env" }, "sk-1");
    expect(text).toBe("OPENAI_API_KEY=sk-1\n");
  });
});

describe("flat insertAtTop (toml root key must precede tables)", () => {
  test("inserts before the first [section] instead of appending at EOF", () => {
    const text = '[providers.openai]\n  base_url = "x"\n';
    const result = textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, "gpt-5");
    expect(result.indexOf('model = "gpt-5"')).toBeLessThan(result.indexOf("[providers.openai]"));
  });

  test("replaces an existing root key in place instead of duplicating", () => {
    const text = 'model = "old"\n\n[section]\n  x = "1"\n';
    const result = textUpsert(text, { kind: "flat", key: "model", insertAtTop: true }, "new");
    expect(result).toContain('model = "new"');
    expect(result).not.toContain('model = "old"');
    expect((result.match(/model = /g) ?? []).length).toBe(1);
  });
});

describe("sectionKey — key nested one level inside [section]", () => {
  test("upserts a new key into an existing section without disturbing siblings", () => {
    const text = '[agents]\n  existing = "keep"\n';
    const result = textUpsert(
      text,
      { kind: "sectionKey", section: "agents", key: "default_subagent_model" },
      "gpt-5",
    );
    expect(result).toContain('existing = "keep"');
    expect(result).toContain('default_subagent_model = "gpt-5"');
  });

  test("creates the section when it doesn't exist yet", () => {
    const result = textUpsert(
      "",
      { kind: "sectionKey", section: "agents", key: "default_subagent_model" },
      "gpt-5",
    );
    expect(result).toContain("[agents]");
    expect(result).toContain('default_subagent_model = "gpt-5"');
  });

  test("replaces an existing sectionKey value in place", () => {
    const text = '[agents]\n  default_subagent_model = "old"\n';
    const result = textUpsert(
      text,
      { kind: "sectionKey", section: "agents", key: "default_subagent_model" },
      "new",
    );
    expect(result).toContain('default_subagent_model = "new"');
    expect(result).not.toContain('"old"');
  });

  test("reads a sectionKey value scoped to its section, ignoring same-named root keys", () => {
    const text =
      'default_subagent_model = "root"\n\n[agents]\n  default_subagent_model = "scoped"\n';
    expect(
      textGet(text, { kind: "sectionKey", section: "agents", key: "default_subagent_model" }),
    ).toBe("scoped");
  });

  test("removes one sectionKey while preserving sibling keys and the section header", () => {
    const text = '[agents]\n  keep = "1"\n  default_subagent_model = "gpt-5"\n';
    const result = textRemove(text, {
      kind: "sectionKey",
      section: "agents",
      key: "default_subagent_model",
    });
    expect(result).toContain('keep = "1"');
    expect(result).not.toContain("default_subagent_model");
    expect(result).toContain("[agents]");
  });

  test("recovers a malformed file where the key landed on the header line", () => {
    const text = '[agents] default_subagent_model = "stale"\n';
    const result = textUpsert(
      text,
      { kind: "sectionKey", section: "agents", key: "default_subagent_model" },
      "fixed",
    );
    expect(result).toBe('[agents]\n  default_subagent_model = "fixed"\n\n');
  });
});

describe("section — whole [section] block as an opaque body", () => {
  test("creates a new section block at EOF", () => {
    const result = textUpsert(
      "",
      { kind: "section", section: "model" },
      'default = "gpt-5"\nbase_url = "http://x"',
    );
    expect(result).toBe('\n[model]\ndefault = "gpt-5"\nbase_url = "http://x"\n\n');
  });

  test("replaces an existing section's body wholesale", () => {
    const text = '[model]\ndefault = "old"\nbase_url = "http://old"\n\n[other]\n  x = "1"\n';
    const result = textUpsert(text, { kind: "section", section: "model" }, 'default = "new"');
    expect(result).toContain('default = "new"');
    expect(result).not.toContain('"old"');
    expect(result).toContain("[other]");
    expect(result).toContain('x = "1"');
  });

  test("removes a section and trims leading blank lines left behind", () => {
    const text = '[model]\ndefault = "gpt-5"\n\n[other]\n  x = "1"\n';
    const result = textRemove(text, { kind: "section", section: "model" });
    expect(result).not.toContain("[model]");
    expect(result).toContain("[other]");
    expect(result.startsWith("\n")).toBe(false);
  });

  test("textHas detects the section header even with a commented-out sibling", () => {
    expect(textHas('[model]\ndefault = "x"\n', { kind: "section", section: "model" })).toBe(true);
    expect(textHas("[other]\n", { kind: "section", section: "model" })).toBe(false);
  });

  test("textGet returns the section body for kind:section", () => {
    const text = '[model]\ndefault = "gpt-5"\n\n[other]\n';
    expect(textGet(text, { kind: "section", section: "model" })).toBe('\ndefault = "gpt-5"\n\n');
    expect(textGet(text, { kind: "section", section: "missing" })).toBeNull();
  });
});
