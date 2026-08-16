import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type StoreModule = typeof import("../../src/lib/store");

// The store initializes module-level signals from localStorage, so each test
// reloads the module against a clean storage snapshot for isolation.
async function loadStore(): Promise<StoreModule> {
  vi.resetModules();
  return import("../../src/lib/store");
}

describe("signals store", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  test("starts from system theme, expanded sidebar, and anonymous session", async () => {
    const store = await loadStore();

    expect(store.theme()).toBe("system");
    expect(store.sidebarCollapsed()).toBe(false);
    expect(store.userSession()).toEqual({ token: null, user: null });
  });

  test("round-trips theme changes through localStorage", async () => {
    const store = await loadStore();

    store.setTheme("dark");
    expect(store.theme()).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");

    store.setTheme("light");
    expect(store.theme()).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
  });

  test("round-trips sidebar collapse state through localStorage", async () => {
    const store = await loadStore();

    store.setSidebarCollapsed(true);
    expect(store.sidebarCollapsed()).toBe(true);
    expect(localStorage.getItem("sidebarCollapsed")).toBe("true");

    store.setSidebarCollapsed(false);
    expect(store.sidebarCollapsed()).toBe(false);
    expect(localStorage.getItem("sidebarCollapsed")).toBe("false");
  });

  test("login persists the token and user payload", async () => {
    const store = await loadStore();

    store.login("tok-1", { name: "Operator", role: "admin" });

    expect(store.userSession()).toEqual({ token: "tok-1", user: { name: "Operator", role: "admin" } });
    expect(localStorage.getItem("sessionToken")).toBe("tok-1");
    expect(JSON.parse(localStorage.getItem("sessionUser") ?? "{}")).toEqual({ name: "Operator", role: "admin" });
  });

  test("refreshToken swaps only the token and keeps the user", async () => {
    const store = await loadStore();
    store.login("tok-1", { name: "Operator" });

    store.refreshToken("tok-2");

    expect(store.userSession()).toEqual({ token: "tok-2", user: { name: "Operator" } });
    expect(localStorage.getItem("sessionToken")).toBe("tok-2");
    expect(JSON.parse(localStorage.getItem("sessionUser") ?? "{}")).toEqual({ name: "Operator" });
  });

  test("logout clears the session keys from storage", async () => {
    const store = await loadStore();
    store.login("tok-1", { name: "Operator" });
    expect(localStorage.getItem("sessionToken")).toBe("tok-1");

    store.logout();

    expect(store.userSession()).toEqual({ token: null, user: null });
    expect(localStorage.getItem("sessionToken")).toBeNull();
    expect(localStorage.getItem("sessionUser")).toBeNull();
  });

  test("rehydrates persisted state when the module reloads", async () => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("sidebarCollapsed", "true");
    localStorage.setItem("sessionToken", "tok-9");
    localStorage.setItem("sessionUser", JSON.stringify({ name: "Operator" }));

    const store = await loadStore();

    expect(store.theme()).toBe("dark");
    expect(store.sidebarCollapsed()).toBe(true);
    expect(store.userSession()).toEqual({ token: "tok-9", user: { name: "Operator" } });
  });

  test("glass surfaces default off, toggles the document data-glass attribute, and persists", async () => {
    const store = await loadStore();

    expect(store.glassSurfaces()).toBe(false);
    expect(document.documentElement.dataset.glass).toBe("off");

    store.setGlassSurfaces(true);

    expect(store.glassSurfaces()).toBe(true);
    expect(document.documentElement.dataset.glass).toBe("on");
    expect(localStorage.getItem("glassSurfaces")).toBe("true");

    store.setGlassSurfaces(false);
    expect(document.documentElement.dataset.glass).toBe("off");
    expect(localStorage.getItem("glassSurfaces")).toBe("false");
  });

  test("theme signal drives the .dark class on the document root", async () => {
    const store = await loadStore();

    store.setTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    store.setTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
