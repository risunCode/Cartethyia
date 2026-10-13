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
  test("the explicit choices pass through", () => {
    expect(parseConsoleTheme("light")).toBe("light");
    expect(parseConsoleTheme("dark")).toBe("dark");
  });

  test("unknown and legacy choices resolve to the dark default", () => {
    expect(parseConsoleTheme(null)).toBe("dark");
    expect(parseConsoleTheme(undefined)).toBe("dark");
    expect(parseConsoleTheme("")).toBe("dark");
    expect(parseConsoleTheme("DARK")).toBe("dark");
    expect(parseConsoleTheme("Dark")).toBe("dark");
    expect(parseConsoleTheme("  dark  ")).toBe("dark");
    expect(parseConsoleTheme("auto")).toBe("dark");
    expect(parseConsoleTheme("system")).toBe("dark");
    expect(parseConsoleTheme(0)).toBe("dark");
    expect(parseConsoleTheme({ theme: "dark" })).toBe("dark");
  });

  test("the comparison is exact, so a near-miss is rejected", () => {
    // `"dark "` with a trailing space is not `"dark"`. Pinned because a
    // `.trim()`-based reader would accept it, and the two would then disagree
    // with the bootstrap script in `index.html`.
    expect(parseConsoleTheme("dark ")).toBe("dark");
    expect(parseConsoleTheme(" dark")).toBe("dark");
  });

  test("the result is always in the documented union", () => {
    const choices: readonly ConsoleThemeChoice[] = ["light", "dark"];
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

  test("nothing stored defaults to dark", () => {
    expect(readConsoleTheme()).toBe("dark");
  });

  test("a legacy system preference defaults to dark", () => {
    window.localStorage.setItem(CONSOLE_THEME_KEY, "system");
    expect(readConsoleTheme()).toBe("dark");
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

  test("a corrupt stored value resolves to the dark default", () => {
    window.localStorage.setItem(CONSOLE_THEME_KEY, "chartreuse");
    expect(readConsoleTheme("light")).toBe("dark");
  });

  test("a storage read that throws returns the fallback", () => {
    // A private window or a blocked origin makes getItem throw. The try/catch is
    // what keeps the console from failing to render.
    const original = window.localStorage.getItem.bind(window.localStorage);
    window.localStorage.getItem = () => {
      throw new Error("storage is blocked");
    };
    try {
      expect(readConsoleTheme()).toBe("dark");
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
  test("reports the explicit theme without consulting the OS", () => {
    expect(isDarkEffective("dark")).toBe(true);
    expect(isDarkEffective("light")).toBe(false);
  });
});

describe("applyConsoleTheme", () => {
  test("the explicit theme lands on the root", () => {
    applyConsoleTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyConsoleTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
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
    for (const theme of ["light", "dark"] as const satisfies readonly ConsoleThemeChoice[]) {
      writeConsoleTheme(theme);
      expect(readConsoleTheme()).toBe(theme);
    }
  });
});
