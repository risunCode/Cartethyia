import { onCleanup, onMount, type JSX } from "solid-js";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "theme";

function storageTheme(): Theme | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveTheme(preference = storageTheme()): Theme {
  return preference ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme application still succeeds when storage is unavailable.
  }
}

/**
 * Applies the persisted preference (or the OS preference) and follows OS
 * changes until the user explicitly chooses light or dark.
 */
export function ThemeProvider(props: { children: JSX.Element }): JSX.Element {
  const preference = storageTheme();
  applyTheme(resolveTheme(preference));

  onMount(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    if (storageTheme() !== null) return;
    const onChange = (): void => applyTheme(systemTheme());
    media.addEventListener("change", onChange);
    onCleanup(() => media.removeEventListener("change", onChange));
  });

  return props.children;
}
