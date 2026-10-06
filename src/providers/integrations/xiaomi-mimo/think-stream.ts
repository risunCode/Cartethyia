/**
 * Splits inline thinking tags in the Xiaomi MiMo Studio SSE stream.
 *
 * Studio interleaves `<think>` or `<thinking>` spans with answer text and
 * NUL padding. Desktop uses the separate `reasoning_content` chat field,
 * so its standard OpenAI-compatible stream decoder does not use this splitter.
 *
 * The splitter is stateful because a tag can straddle two SSE frames: the
 * `<thi` of one chunk and the `nk>` of the next are one opening tag, and a
 * stateless regex would emit the fragment as text. It therefore holds back a
 * trailing run that could still become a tag until the next chunk settles it.
 *
 * Two further quirks are handled here rather than at each call site:
 * - NUL bytes (`\u0000`) are injected by the upstream between thought tokens;
 *   forwarded verbatim they break JSON encoders and terminal renderers.
 * - Text before an opening tag is the answer (some models answer first and
 *   reason afterwards), so it stays content; only the enclosed span becomes
 *   reasoning.
 */

/** Tags whose enclosed span is reasoning, longest-first so `</thinking>` is never split as `<t`. */
const OPEN_TAGS = ["<thinking>", "<think>"] as const;
const CLOSE_TAGS = ["</thinking>", "</think>"] as const;

/** The longest suffix of `text` that is a proper prefix of any tag. */
function danglingTagPrefix(text: string): string {
  const tags = [...OPEN_TAGS, ...CLOSE_TAGS];
  const maxLength = Math.max(...tags.map((tag) => tag.length)) - 1;
  const limit = Math.min(maxLength, text.length);
  for (let length = limit; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (tags.some((tag) => tag.startsWith(suffix))) return suffix;
  }
  return "";
}

/** Strips the NUL padding MiMo injects into thought streams. */
function stripNul(text: string): string {
  return text.includes("\u0000") ? text.replace(/\u0000/g, "") : text;
}

export interface ThinkSplit {
  /** Answer text, with all reasoning spans removed. */
  readonly text: string;
  /** Reasoning text, tag-free. Empty when the chunk carried no thought. */
  readonly reasoning: string;
}

/**
 * Splits one upstream text chunk into answer text and reasoning text.
 *
 * Call `flush()` once the upstream stream ends to release any text the
 * splitter held back while it waited for a possible tag to complete.
 */
export class MimoThinkSplitter {
  #buffer = "";
  #inReasoning = false;

  /** Feeds a chunk; returns the text/reasoning split for everything settled. */
  push(chunk: string): ThinkSplit {
    this.#buffer += stripNul(chunk);
    let text = "";
    let reasoning = "";

    for (;;) {
      if (!this.#inReasoning) {
        const opened = this.#findOpen();
        if (opened === undefined) break;
        text += this.#buffer.slice(0, opened.index);
        this.#buffer = this.#buffer.slice(opened.index + opened.length);
        this.#inReasoning = true;
        continue;
      }
      const closed = this.#findClose();
      if (closed === undefined) break;
      reasoning += this.#buffer.slice(0, closed.index);
      this.#buffer = this.#buffer.slice(closed.index + closed.length);
      this.#inReasoning = false;
    }

    // Hold back a suffix that could still grow into a tag; the rest is settled.
    const held = danglingTagPrefix(this.#buffer);
    const settled = held.length > 0 ? this.#buffer.slice(0, -held.length) : this.#buffer;
    this.#buffer = held;
    if (this.#inReasoning) reasoning += settled;
    else text += settled;

    return { text, reasoning };
  }

  /** Releases text held back for a tag that never completed. */
  flush(): ThinkSplit {
    const rest = this.#buffer;
    this.#buffer = "";
    return this.#inReasoning ? { text: "", reasoning: rest } : { text: rest, reasoning: "" };
  }

  #findOpen(): { index: number; length: number } | undefined {
    let best: { index: number; length: number } | undefined;
    for (const tag of OPEN_TAGS) {
      const index = this.#buffer.indexOf(tag);
      if (index === -1) continue;
      if (best === undefined || index < best.index) best = { index, length: tag.length };
    }
    return best;
  }

  #findClose(): { index: number; length: number } | undefined {
    let best: { index: number; length: number } | undefined;
    for (const tag of CLOSE_TAGS) {
      const index = this.#buffer.indexOf(tag);
      if (index === -1) continue;
      if (best === undefined || index < best.index) best = { index, length: tag.length };
    }
    return best;
  }
}

