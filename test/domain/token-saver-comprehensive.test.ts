import { describe, expect, test } from "bun:test";
import { applyTokenSaver } from "../../src/domain/token-saver";
import type { NormalizedProviderRequest } from "../../src/domain/contracts";

const base: NormalizedProviderRequest = {
  model: "test",
  messages: [
    { role: "user", content: [{ type: "text", text: "older request" }] },
    { role: "tool", content: [{ type: "tool_result", text: "z".repeat(10_000) }] },
    { role: "user", content: [{ type: "text", text: "request" }] },
    { role: "tool", content: [{ type: "tool_result", text: "x".repeat(10_000) }] },
    { role: "assistant", content: [{ type: "text", text: "answer" }] },
    { role: "tool", content: [{ type: "tool_result", text: "y".repeat(10_000) }] },
  ],
  tools: [], stream: false, responseFormat: "text", reasoning: "default", maxOutputTokens: null, images: [], sourceSurface: "openai-chat", signal: new AbortController().signal,
  limits: { maxBodyBytes: 100_000, connectTimeoutMs: 100, firstByteTimeoutMs: 100, idleTimeoutMs: 100, totalTimeoutMs: 1000 },
};

/** A tool_result with the given text, useful for building single-block messages. */
function toolMessage(text: string): { role: "tool"; content: [{ type: "tool_result"; text: string }] } {
  return { role: "tool", content: [{ type: "tool_result", text }] };
}

/** Pulls the single tool_result text out of a message's first content block. */
function blockText(msg: { readonly content: readonly { readonly text?: string }[] }): string | undefined {
  return msg.content[0]?.text;
}

describe("Token Saver — quality levels", () => {
  test("lite uses a larger budget than balanced so old tool results stay longer", () => {
    // lite: keepLastTurns=3 → cutoff = max(0, 6 - 3*2) = 0, so every message is protected.
    // To exercise compression under lite we need more messages so cutoff > 0.
    const padded = {
      ...base,
      messages: [
        { role: "tool" as const, content: [{ type: "tool_result" as const, text: "a".repeat(10_000) }] },
        ...base.messages,
      ],
    };
    const result = applyTokenSaver(padded, { enabled: true, quality: "lite" });
    const compressed = blockText(result.messages[0]!);
    expect(compressed!.length).toBeLessThan(10_000);
    // lite maxChars is 8_000; compressed text should not exceed that envelope.
    expect(compressed!.length).toBeLessThanOrEqual(8_000);
  });

  test("extreme uses the smallest budget, trimming old tool results aggressively", () => {
    const result = applyTokenSaver(base, { enabled: true, quality: "extreme" });
    const compressed = blockText(result.messages[1]!);
    expect(compressed!.length).toBeLessThan(4_000);
  });

  test("extreme protects only the most recent turn (keepLastTurns = 1)", () => {
    const result = applyTokenSaver(base, { enabled: true, quality: "extreme" });
    // extreme: keepLastTurns=1 → cutoff = max(0, 6 - 1*2) = 4.
    // The last tool_result (index 5) is within the most recent turn and must be untouched.
    expect(blockText(result.messages[5]!)).toHaveLength(10_000);
    // The middle tool_result (index 3) is below cutoff 4 and is compressed.
    expect(blockText(result.messages[3]!)!.length).toBeLessThan(10_000);
  });
});

describe("Token Saver — smartTruncate flag", () => {
  test("smartTruncate=false falls back to generic truncation for large tool results", () => {
    const diff = Array.from({ length: 500 }, (_, index) => index === 0 ? "@@ -1,40 +1,40 @@" : `+changed line ${index}`).join("\n");
    const request = { ...base, messages: [toolMessage(diff), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced", smartTruncate: false });
    const text = blockText(result.messages[0]!);
    // Generic truncation emits the char/line marker; smart git-diff would emit "hunk lines elided".
    expect(text).toContain("…[truncated");
    expect(text).not.toContain("hunk lines elided");
  });

  test("smartTruncate omitted (default true) still applies smart filters", () => {
    const diff = Array.from({ length: 500 }, (_, index) => index === 0 ? "@@ -1,40 +1,40 @@" : `+changed line ${index}`).join("\n");
    const request = { ...base, messages: [toolMessage(diff), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    const text = blockText(result.messages[0]!);
    expect(text).toContain("@@ -1,40 +1,40 @@");
  });
});

describe("Token Saver — sub-threshold and trivial inputs", () => {
  test("sub-threshold input is not truncated when below the compressible minimum", () => {
    const small = "short tool output that is well under any limit";
    const request = { ...base, messages: [toolMessage(small), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "extreme" });
    expect(blockText(result.messages[0]!)).toBe(small);
  });

  test("empty messages array returns the request unchanged", () => {
    const request: NormalizedProviderRequest = { ...base, messages: [] };
    const result = applyTokenSaver(request, { enabled: true, quality: "extreme" });
    expect(result.messages).toHaveLength(0);
  });

  test("single message is protected from truncation regardless of quality", () => {
    const big = "a".repeat(10_000);
    const request: NormalizedProviderRequest = { ...base, messages: [toolMessage(big)] };
    const result = applyTokenSaver(request, { enabled: true, quality: "extreme" });
    // With one message, cutoff = max(0, 1 - 1*2) = 0, so index 0 >= cutoff → untouched.
    expect(blockText(result.messages[0]!)).toHaveLength(10_000);
  });
});

describe("Token Saver — smart filter detectors", () => {
  test("tree filter preserves top-level tree structure and collapses deep entries", () => {
    const lines: string[] = ["root"];
    for (let i = 0; i < 60; i += 1) {
      lines.push(`├── dir${i}`);
      for (let j = 0; j < 10; j += 1) lines.push(`│  └── file${i}-${j}`);
    }
    const tree = lines.join("\n");
    const request = { ...base, messages: [toolMessage(tree), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    const text = blockText(result.messages[0]!);
    expect(text).toContain("root");
    expect(text).toContain("deeper entries collapsed");
    expect(text!.length).toBeLessThan(tree.length);
  });

  test("grep output below the limit is preserved as-is (no false compression)", () => {
    const matches = Array.from({ length: 60 }, (_, i) => `src/module${i % 3}.ts:${100 + i}:matched line content ${i}`).join("\n");
    const request = { ...base, messages: [toolMessage(matches), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    expect(blockText(result.messages[0]!)).toBe(matches);
  });

  test("large grep output above the limit is truncated via generic fallback", () => {
    const matches = Array.from({ length: 200 }, (_, i) => `src/module${i % 3}.ts:${100 + i}:matched line content ${i}`).join("\n");
    const request = { ...base, messages: [toolMessage(matches), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    const text = blockText(result.messages[0]!);
    expect(text).toContain("…[truncated");
    expect(text!.length).toBeLessThan(matches.length);
  });

  test("read-numbered filter elides middle lines of numbered file reads", () => {
    // The detector regex requires whitespace AFTER the separator char.
    const lines = Array.from({ length: 400 }, (_, i) => `${i}→ line content ${i}`);
    const numbered = lines.join("\n");
    const request = { ...base, messages: [toolMessage(numbered), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    const text = blockText(result.messages[0]!);
    expect(text).toContain("numbered lines elided");
    expect(text!.length).toBeLessThan(numbered.length);
  });

  test("git-status filter summarizes staged, modified, and untracked files", () => {
    const status = [
      "On branch main",
      "M  staged-file.ts",
      " M modified-file.ts",
      "?? untracked-file.ts",
    ].join("\n");
    // Pad well past the balanced 4_000-char limit so the lossy git-status filter fires.
    const request = { ...base, messages: [toolMessage(status + "\n" + "x".repeat(5_000)), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    const text = blockText(result.messages[0]!);
    expect(text).toContain("Staged:");
    expect(text).toContain("Modified:");
    expect(text).toContain("Untracked:");
    expect(text).toContain("main");
  });
});

describe("Token Saver — generic fallback and dedup", () => {
  test("generic fallback truncates unmatched large output with a marker", () => {
    // No special structure — just repeated unique-ish lines so no filter matches.
    const blob = Array.from({ length: 600 }, (_, i) => `unique filler line number ${i} with enough variance`).join("\n");
    const request = { ...base, messages: [toolMessage(blob), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    const text = blockText(result.messages[0]!);
    expect(text).toContain("…[truncated");
    expect(text!.length).toBeLessThan(blob.length);
  });

  test("lossless dedup removes exact duplicate lines without lossy truncation marker", () => {
    const repeated = Array.from({ length: 500 }, () => "same log line").join("\n");
    const request = { ...base, messages: [toolMessage(repeated), ...base.messages] };
    const result = applyTokenSaver(request, { enabled: true, quality: "balanced" });
    const text = blockText(result.messages[0]!);
    // Dedup is lossless: it collapses duplicates but never emits the generic truncation marker.
    expect(text).toContain("duplicate");
    expect(text).not.toContain("…[truncated");
  });
});
