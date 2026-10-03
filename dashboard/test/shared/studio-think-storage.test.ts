/**
 * The Model Lab's persisted thinking level.
 *
 * The bug this pins: the level lived in a plain `useState("high")`, so every
 * page change reset it to the default and the operator's choice never reached
 * the next request. The fix routes the value through storage, which makes two
 * properties load-bearing:
 *
 * - **A stored value is untrusted.** localStorage is writable by any script on
 *   the origin and by devtools. An unrecognised value must resolve to the
 *   documented default, never flow into the request body as
 *   `reasoning_effort: <garbage>`.
 * - **Storage can throw.** A private window, a full quota, or a blocked origin
 *   makes `getItem`/`setItem` throw. Neither a read nor a write may break the
 *   composer render.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { registerDom } from "../helpers/dom";
import {
  readEnumStorage,
  STUDIO_THINK_STORAGE,
  writeEnumStorage,
} from "../../src/shared/studio-session-storage";

registerDom();

// Mirrors the closed set `THINK_LEVELS` projects in `Studio.tsx`.
const LEVELS = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof LEVELS)[number];
const FALLBACK: Level = "high";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("readEnumStorage", () => {
  test("a stored member of the set is returned", () => {
    for (const level of LEVELS) {
      window.localStorage.setItem(STUDIO_THINK_STORAGE, level);
      expect(readEnumStorage(STUDIO_THINK_STORAGE, LEVELS, FALLBACK)).toBe(level);
    }
  });

  test("nothing stored falls back to the default", () => {
    expect(readEnumStorage(STUDIO_THINK_STORAGE, LEVELS, FALLBACK)).toBe(FALLBACK);
  });

  test("a value outside the set falls back rather than reaching the request", () => {
    for (const garbage of ["ultra", "HIGH", " high", "high ", "none", "{}", "0"]) {
      window.localStorage.setItem(STUDIO_THINK_STORAGE, garbage);
      expect(readEnumStorage(STUDIO_THINK_STORAGE, LEVELS, FALLBACK)).toBe(FALLBACK);
    }
  });

  test("the comparison is exact, so case and whitespace are rejected", () => {
    // Pinned because a `.trim().toLowerCase()` reader would accept these and
    // then disagree with the option list the Select renders.
    window.localStorage.setItem(STUDIO_THINK_STORAGE, "High");
    expect(readEnumStorage(STUDIO_THINK_STORAGE, LEVELS, FALLBACK)).toBe(FALLBACK);
  });

  test("a storage read that throws returns the fallback", () => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error("storage is blocked");
    };
    try {
      expect(readEnumStorage(STUDIO_THINK_STORAGE, LEVELS, FALLBACK)).toBe(FALLBACK);
    } finally {
      window.localStorage.getItem = original;
    }
  });
});

describe("writeEnumStorage", () => {
  test("a written level reads back through readEnumStorage", () => {
    for (const level of LEVELS) {
      writeEnumStorage(STUDIO_THINK_STORAGE, level);
      expect(readEnumStorage(STUDIO_THINK_STORAGE, LEVELS, FALLBACK)).toBe(level);
    }
  });

  test("the write lands in localStorage so it survives a page change", () => {
    // The bug was that a page change reset the level; session scope would not
    // be enough on its own, but local scope is what matches the provider card.
    writeEnumStorage(STUDIO_THINK_STORAGE, "xhigh");
    expect(window.localStorage.getItem(STUDIO_THINK_STORAGE)).toBe("xhigh");
  });

  test("a write failure is swallowed, not thrown", () => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      expect(() => writeEnumStorage(STUDIO_THINK_STORAGE, "low")).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe("the storage key", () => {
  test("is the documented one", () => {
    // A rename would silently orphan every operator's stored level, because the
    // read would simply find nothing and fall back to the default.
    expect(STUDIO_THINK_STORAGE).toBe("cartethyia:studio:thinking-level");
  });

  test("does not collide with the other studio keys", () => {
    writeEnumStorage(STUDIO_THINK_STORAGE, "max");
    expect(window.localStorage.getItem("cartethyia:studio:active-session")).toBeNull();
    expect(window.localStorage.getItem("cartethyia:studio:key")).toBeNull();
  });
});
