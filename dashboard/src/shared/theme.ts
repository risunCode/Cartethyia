/**
 * Single source of truth for the `console-theme` preference.
 *
 * Shared by the pre-bundle bootstrap in `dashboard/index.html` and the
 * topbar `ThemeToggle` in `components/Shell.tsx`. Every read, write, and DOM
 * application of the theme value must flow through this module so those
 * callsites cannot drift.
 *
 * The inline script in `index.html` necessarily duplicates the parse/apply
 * logic (it runs before the bundle loads); it is annotated to point here and
 * must be kept in sync manually if these values ever change.
 */

export type ConsoleThemeChoice = "system" | "light" | "dark";

/** localStorage key for the persisted console theme. */
export const CONSOLE_THEME_KEY = "console-theme";

export function parseConsoleTheme(value: unknown): ConsoleThemeChoice {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function readConsoleTheme(fallback: ConsoleThemeChoice = "system"): ConsoleThemeChoice {
  if (typeof window === "undefined" || !window.localStorage) return fallback;
  try {
    return parseConsoleTheme(window.localStorage.getItem(CONSOLE_THEME_KEY) ?? fallback);
  } catch {
    return fallback;
  }
}

/** Resolves the effective dark mode for a stored choice (system follows the OS). */
export function isDarkEffective(theme: ConsoleThemeChoice): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/**
 * Applies a theme choice through the root data-theme attribute.
 */
export function applyConsoleTheme(theme: ConsoleThemeChoice): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

/** Persists a theme choice and applies it to the document. Storage errors are ignored. */
export function writeConsoleTheme(theme: ConsoleThemeChoice): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CONSOLE_THEME_KEY, theme);
    } catch {
      // Storage write error ignored — the DOM application below still takes effect.
    }
  }
  applyConsoleTheme(theme);
}
