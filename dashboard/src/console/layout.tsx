/* @jsxImportSource solid-js */

import { createEffect, createSignal, type JSX } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { Cable, ChartSpline, LayoutDashboard, LogOut, Menu, Moon, Settings, Sun, X } from "lucide-solid";

import { consoleGet, consolePost } from "../lib/console-api";
import { NAV_GROUPS, TITLES } from "./navigation";

const GITHUB_REPO = "risunCode/Cartethyia";

function iconFor(path: string) {
  if (path === "/overview") return LayoutDashboard;
  if (path === "/usage") return ChartSpline;
  if (path === "/providers") return Cable;
  return Settings;
}

export function AppShell(props: { children?: JSX.Element }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [dark, setDark] = createSignal(document.documentElement.classList.contains("dark"));
  const [adminName] = createSignal(localStorage.getItem("cartethyia.adminName") ?? "Admin");

  createEffect(() => {
    void consoleGet("/auth/session").catch((error: unknown) => {
      if (error instanceof Error && "status" in error && error.status === 401) navigate("/login", { replace: true });
    });
  });

  const toggleTheme = (): void => {
    const next = !dark();
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const logout = async (): Promise<void> => {
    await consolePost("/auth/logout").catch(() => undefined);
    navigate("/login", { replace: true });
  };

  const pathKey = () => {
    const path = location.pathname.replace(/^\/console/, "").replace(/\/$/, "") || "/overview";
    if (TITLES[path]) return path;
    if (path.startsWith("/providers/")) return "/providers";
    return "/overview";
  };

  return <div class="min-h-dvh bg-[var(--page-bg)] text-[var(--text-1)]">
    <ShowDrawer open={drawerOpen()} onClose={() => setDrawerOpen(false)}>
      <aside class="glass fixed inset-y-4 left-4 z-70 flex w-[272px] flex-col rounded-[var(--radius-sidebar)] p-[18px_14px] lg:static lg:inset-auto lg:flex">
        <div class="flex items-center gap-2.5 px-2 pb-3.5 pt-1.5"><img src={`${import.meta.env.BASE_URL}favicon_love.webp`} alt="Cartethyia" class="h-9 w-9 rounded-[11px] object-cover" /><div class="min-w-0"><a href={`https://github.com/${GITHUB_REPO}`} target="_blank" rel="noreferrer" class="truncate text-base font-bold">Cartethyia Router</a><div class="text-[11px] text-[var(--text-2)]">Console</div></div></div>
        <nav class="min-h-0 flex-1 overflow-y-auto scrollbar-fade">
          {NAV_GROUPS.map((group) => <div><div class="px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">{group.label}</div>{group.items.map((item) => { const Icon = iconFor(item.to); return <A href={item.to} end class="relative flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-[9px] text-[13.5px] font-medium text-[var(--text-2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]" activeClass="font-semibold text-[var(--text-1)] bg-[var(--active-pill)]"><Icon size={18} class="shrink-0" /><span>{item.label}</span></A>; })}</div>)}
        </nav>
        <div class="mt-auto pt-4"><div class="flex items-center gap-2.5 rounded-[13px] border border-[var(--inner-border)] bg-[var(--hover)] p-[9px_10px]"><div class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#ff9f0a] to-[#ff375f] text-xs font-bold text-white">AD</div><div class="min-w-0 flex-1"><div class="truncate text-[13px] font-semibold">{adminName()}</div><div class="text-[11px] text-[var(--text-2)]">Cartethyia console</div></div><button type="button" onClick={() => void logout()} aria-label="Logout" class="grid size-8 place-items-center rounded-lg text-[var(--text-3)] hover:text-[var(--red)]"><LogOut size={15} /></button></div></div>
      </aside>
    </ShowDrawer>

    <div class="mx-auto max-w-[1560px] p-4">
      <main class="min-w-0 lg:ml-[288px]">
        <header class="glass sticky top-4 z-40 mb-4 flex items-center gap-3 rounded-[18px] px-3 py-2.5 sm:px-4 sm:py-3"><button type="button" onClick={() => setDrawerOpen(true)} aria-label="Open menu" class="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] bg-[var(--hover)] lg:hidden"><Menu size={18} /></button><div class="min-w-0 flex-1"><h1 class="truncate text-[15px] font-bold sm:text-[17px]">{TITLES[pathKey()]?.title ?? "Cartethyia"}</h1><p class="truncate text-xs text-[var(--text-2)]">{TITLES[pathKey()]?.sub ?? "Internal console"}</p></div><button type="button" onClick={toggleTheme} aria-label="Toggle theme" class="grid size-9 place-items-center rounded-lg text-[var(--text-2)] hover:bg-[var(--hover)]">{dark() ? <Sun size={16} /> : <Moon size={16} />}</button></header>
        <section>{props.children}</section>
      </main>
    </div>
  </div>;
}

function ShowDrawer(props: { open: boolean; onClose: () => void; children: JSX.Element }) {
  if (!props.open) return <div class="hidden lg:block">{props.children}</div>;
  return <><button type="button" aria-label="Close navigation" onClick={props.onClose} class="fixed inset-0 z-60 bg-black/30 lg:hidden" /><button type="button" aria-label="Close navigation" onClick={props.onClose} class="fixed top-6 right-6 z-80 grid size-9 place-items-center rounded-lg bg-[var(--surface)] lg:hidden"><X size={16} /></button>{props.children}</>;
}