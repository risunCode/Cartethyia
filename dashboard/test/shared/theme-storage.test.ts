/**
 * Console theme preference storage.
 *
 * This module is the boundary between a value the browser persisted and a
 * value the app acts on. The properties that matter are all about hostile or
 * broken input:
 *
 * - **A stored value is untrusted.** `console-theme` lives in localStorage, which
 *   any script on the origin — and the operator's own devtools — can write. An
 *   unrecognised value must resolve to a real choice, never to `undefined`, or the
 *   root `data-theme` attribute gets a value no stylesheet matches.
 * - **Storage can throw.** A private window, a full quota, or a blocked origin
 *   makes `localStorage.getItem` throw rather than return null. The theme reader
 *   must still return a usable choice.
 * `registerDom()` is called at import time rather than in `beforeAll`, because
 * `theme.ts` reads `window` inside its functions and the tests need the globals
 * present before the first call. Each test clears storage itself so the suite
 * does not depend on ordering.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { registerDom } from "../helpers/dom";
import {
  applyConsoleTheme,
  CONSOLE_THEME_KEY,
  type ConsoleThemeChoice,
  isDarkEffective,
  parseConsoleTheme,
  readConsoleTheme,
  writeConsoleTheme,
} from "../../src/lib/theme";

registerDom();

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("parseConsoleTheme", () => {
  test("the three valid choices pass through", () => {
    expect(parseConsoleTheme("light")).toBe("light");
    expect(parseConsoleTheme("dark")).toBe("dark");
    expect(parseConsoleTheme("system")).toBe("system");
  });

  test("anything else resolves to system", () => {
    // The fallback direction matters: an unrecognised value must become a real
    // choice. `system` is the safe one because it defers to the OS rather than
    // forcing a theme the operator did not pick.
    expect(parseConsoleTheme(null)).toBe("system");
    expect(parseConsoleTheme(undefined)).toBe("system");
    expect(parseConsoleTheme("")).toBe("system");
    expect(parseConsoleTheme("DARK")).toBe("system");
    expect(parseConsoleTheme("Dark")).toBe("system");
    expect(parseConsoleTheme("  dark  ")).toBe("system");
    expect(parseConsoleTheme("auto")).toBe("system");
    expect(parseConsoleTheme(0)).toBe("system");
    expect(parseConsoleTheme({ theme: "dark" })).toBe("system");
  });

  test("the comparison is exact, so a near-miss is rejected", () => {
    // `"dark "` with a trailing space is not `"dark"`. Pinned because a
    // `.trim()`-based reader would accept it, and the two would then disagree
    // with the bootstrap script in `index.html`.
    expect(parseConsoleTheme("dark ")).toBe("system");
    expect(parseConsoleTheme(" dark")).toBe("system");
  });

  test("the result is always in the documented union", () => {
    const choices: readonly ConsoleThemeChoice[] = ["system", "light", "dark"];
    for (const input of ["light", "dark", "system", "nonsense", null, 42, []]) {
      expect(choices).toContain(parseConsoleTheme(input));
    }
  });
});

describe("readConsoleTheme", () => {
  test("a stored choice is read back", () => {
    window.localStorage.setItem(CONSOLE_THEME_KEY, "dark");
    expect(readConsoleTheme()).toBe("dark");
    window.localStorage.setItem(CONSOLE_THEME_KEY, "light");
    expect(readConsoleTheme()).toBe("light");
  });

  test("nothing stored falls back to system", () => {
    expect(readConsoleTheme()).toBe("system");
  });

  test("a caller-supplied fallback is used when nothing is stored", () => {
    // The pre-bundle bootstrap passes the value it already resolved; the default
    // parameter is what makes that possible.
    expect(readConsoleTheme("dark")).toBe("dark");
    expect(readConsoleTheme("light")).toBe("light");
  });

  test("a stored value wins over the fallback", () => {
    // The fallback is only for the absent case — otherwise a stored preference
    // could never take effect.
    window.localStorage.setItem(CONSOLE_THEME_KEY, "light");
    expect(readConsoleTheme("dark")).toBe("light");
  });

  test("a corrupt stored value resolves to system, not to the fallback", () => {
    // MEASURED, and it is the subtle case: the read is
    // `parseConsoleTheme(getItem(key) ?? fallback)`. A stored-but-invalid value is
    // not nullish, so the `??` does not fire and the invalid string is passed to
    // the parser, which returns `system`. So a caller passing `"dark"` as the
    // fallback still gets `system` when the stored value is garbage. Pinned
    // because it is not what "fallback" suggests.
    window.localStorage.setItem(CONSOLE_THEME_KEY, "chartreuse");
    expect(readConsoleTheme("dark")).toBe("system");
  });

  test("a storage read that throws returns the fallback", () => {
    // A private window or a blocked origin makes getItem throw. The try/catch is
    // what keeps the console from failing to render.
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error("storage is blocked");
    };
    try {
      expect(readConsoleTheme()).toBe("system");
      expect(readConsoleTheme("light")).toBe("light");
    } finally {
      window.localStorage.getItem = original;
    }
  });

  test("the stored key is the documented one", () => {
    // The bootstrap script in index.html duplicates this literal, so a rename here
    // would desync the two unless the key is pinned.
    expect(CONSOLE_THEME_KEY).toBe("console-theme");
  });
});

describe("isDarkEffective", () => {
  test("an explicit choice is answered directly", () => {
    // No OS consultation for an explicit choice — that is what makes the toggle
    // deterministic.
    expect(isDarkEffective("dark")).toBe(true);
    expect(isDarkEffective("light")).toBe(false);
  });

  test("system consults the OS preference", () => {
    // The harness's matchMedia stand-in always reports `matches: false`, so
    // "system" resolves to light here. The discriminating assertion is the
    // explicit-vs-system split above; this pins the stand-in's contribution so a
    // change to the helper is visible.
    expect(isDarkEffective("system")).toBe(false);
  });

  test("system consults matchMedia rather than assuming light", () => {
    // Replace the WINDOW's matchMedia with one that reports dark, and assert the
    // result follows. Without this the previous test would pass on an
    // implementation that hard-coded `false` for "system".
    //
    // MEASURED: patching `globalThis.matchMedia` does NOT work — the module reads
    // `window.matchMedia`, and the harness registers `window` as happy-dom's own
    // object whose `matchMedia` is a distinct function. I first patched the global
    // and the test failed, which is the correct signal that I was patching the
    // wrong object.
    const windowRecord = window as unknown as Record<string, unknown>;
    const original = windowRecord.matchMedia;
    windowRecord.matchMedia = (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    });
    try {
      expect(isDarkEffective("system")).toBe(true);
      // And an explicit light still wins over a dark OS.
      expect(isDarkEffective("light")).toBe(false);
      // As does an explicit dark over a light OS — checked by the next test.
    } finally {
      windowRecord.matchMedia = original;
    }
  });

  test("a missing matchMedia is handled rather than thrown on", () => {
    // An older browser, or a non-DOM context. The `typeof === "function"` guard
    // means the answer is light rather than a TypeError during render.
    const windowRecord = window as unknown as Record<string, unknown>;
    const original = windowRecord.matchMedia;
    windowRecord.matchMedia = undefined;
    try {
      expect(isDarkEffective("system")).toBe(false);
    } finally {
      windowRecord.matchMedia = original;
    }
  });
});

describe("applyConsoleTheme", () => {
  test("the resolved theme lands on the root, never the raw choice", () => {
    // Stylesheets match "light" and "dark" only. Writing "system" through left
    // the root with a value no rule matches, so the toggle looked dead.
    applyConsoleTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyConsoleTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyConsoleTheme("system");
    expect(document.documentElement.dataset.theme).not.toBe("system");
  });

  test("applying does not write to storage", () => {
    // The split matters: `applyConsoleTheme` is the DOM half and
    // `writeConsoleTheme` is both. A caller that only wants to preview a theme
    // must not persist it.
    applyConsoleTheme("dark");
    expect(window.localStorage.getItem(CONSOLE_THEME_KEY)).toBeNull();
  });
});

describe("writeConsoleTheme", () => {
  test("it persists the choice and applies it", () => {
    writeConsoleTheme("dark");
    expect(window.localStorage.getItem(CONSOLE_THEME_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  test("a storage write failure still applies the theme", () => {
    // The comment says so explicitly: the DOM application takes effect even when
    // persistence fails. Without that, a full quota would leave the operator's
    // toggle apparently dead.
    const original = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      writeConsoleTheme("light");
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      window.localStorage.setItem = original;
    }
  });

  test("a round trip through storage returns the same choice", () => {
    // The property that makes the preference survive a reload.
    for (const theme of ["light", "dark", "system"] as const satisfies readonly ConsoleThemeChoice[]) {
      writeConsoleTheme(theme);
      expect(readConsoleTheme()).toBe(theme);
    }
  });
});
