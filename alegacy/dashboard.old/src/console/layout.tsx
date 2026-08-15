import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Clock,
  Globe,
  LogOut,
  Menu,
  Moon,
  Pencil,
  Check,
  Rocket,
  Sun,
  Timer,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { cn } from "../lib/cn";
import type { RepositoryBranchUpdate } from "../lib/repository-updates";
import { daemonGet, daemonPost } from "../lib/daemon-api";
import { useDashboardHealth, type DashboardSummaryView, type DashboardViewState } from "../features/overview/health";
import { qk } from "../lib/query-keys";
import { formatUptime } from "../lib/format";
import { toast } from "../lib/toast";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { CustomAtmosphere } from "../features/customization/background";
import { ADVANCED_NAV_GROUPS, ADVANCED_PATHS, NAV_GROUPS, TITLES } from "./navigation";
import { useSidebarNavigation } from "../composables/navigation/use-sidebar-navigation";

type HealthStatus = DashboardSummaryView;

interface AppearanceSettingsResponse {
  settings: {
    runtime: {
      sidebarIconDataUrl: string | null;
    };
  };
}

const GITHUB_REPO = "risunCode/Cartethyia";

// ---------------------------------------------------------------------------
// FooterClock — isolated so the 1-second tick never re-renders AppShell or
// any page inside <Outlet />.
// ---------------------------------------------------------------------------
function FooterClock({ statusData, state, isStale }: { statusData: HealthStatus | undefined; state: DashboardViewState; isStale: boolean }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const serverNow = new Date(nowMs);
  const fmt = (date: Date) => date.toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false });

  return (
    <footer className="glass z-30 mt-auto grid w-full grid-cols-2 items-center gap-x-4 gap-y-1.5 rounded-2xl px-4 py-3 text-xs text-[var(--text-2)] sm:gap-x-8 sm:px-5 sm:py-3.5">
      <div className="flex items-center gap-1.5 font-semibold text-[var(--text-1)]">
        {state === "offline" || state === "unavailable" || state === "forbidden" ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--red)]" />
            {state === "forbidden" ? "System access forbidden" : "System offline"}
          </>
        ) : state === "degraded" || isStale ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" />
            System degraded
          </>
        ) : state === "malformed" ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" />
            System contract invalid
          </>
        ) : state === "empty" ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" />
            System data unavailable
          </>
        ) : state === "unknown" ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" />
            System status unknown
          </>
        ) : state === "ready" ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--green)]" />
            All systems operational
          </>
        ) : (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" />
            Connecting…
          </>
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5" title="UTC time">
        <Globe size={13} className="shrink-0" />
        {fmt(serverNow)} UTC
      </div>
      <div className="flex items-center gap-1.5" title="Daemon environment">
        <Clock size={13} className="shrink-0" />
        {statusData?.environment ?? "unknown"} environment
      </div>
      <div className="flex items-center justify-end gap-1.5" title="Daemon uptime">
        <Timer size={13} className="shrink-0" />
        uptime {statusData?.uptime ?? formatUptime(null)}
      </div>
    </footer>
  );
}



function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const swapTheme = () => {
    const next = dark ? "light" : "dark";
    const startViewTransition = document.startViewTransition?.bind(document);

    if (!startViewTransition) {
      setTheme(next);
      return;
    }

    const root = document.documentElement;
    root.dataset.themeWipe = "on";

    const transition = startViewTransition(() => {
      setTheme(next);
    });
    void transition.finished.finally(() => {
      delete root.dataset.themeWipe;
    });
  };

  return (
    <button
      type="button"
      onClick={swapTheme}
      aria-label="Toggle theme"
      className="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-1)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--active-pill)] active:scale-90"
    >
      <span key={dark ? "sun" : "moon"} className="theme-icon-enter grid place-items-center">
        {dark ? <Sun size={17} /> : <Moon size={17} />}
      </span>
    </button>
  );
}

function NotificationsDialog({
  open,
  onClose,
  state,
  isStale,
  updateAvailable,
  releaseUpdateAvailable,
  latestTag,
  repositoryUpdates,
}: {
  open: boolean;
  onClose: () => void;
  state: DashboardViewState;
  isStale: boolean;
  updateAvailable: boolean;
  releaseUpdateAvailable: boolean;
  latestTag: string | undefined;
  repositoryUpdates: readonly RepositoryBranchUpdate[];
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    const onClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onClickOutside, { capture: true });
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("button")?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onClickOutside, { capture: true });
      returnFocusRef.current?.focus();
    };
  }, [open]);
  const statusTitle = state === "offline" || state === "unavailable"
    ? "System status unavailable"
    : state === "forbidden"
      ? "System access forbidden"
      : state === "ready" && !isStale
      ? "All systems operational"
      : state === "degraded" || isStale
        ? "System degraded"
        : state === "malformed"
          ? "System contract invalid"
          : state === "empty"
            ? "System returned no health data"
            : state === "unknown"
              ? "System status unknown"
              : "Checking system status";
  return (
    <>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Notifications"
          tabIndex={-1}
          className="popout-enter absolute right-0 top-[calc(100%+16px)] z-50 max-h-[calc(100dvh-120px)] w-[min(360px,calc(100vw-2rem))] origin-top-right overflow-auto rounded-[20px] border border-[var(--inner-border)] bg-[var(--bg-1)] p-2.5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] sm:right-0 sm:w-[360px]"
        >
          <div className="flex items-center gap-2 px-2 pb-2.5 pt-1">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]">
              <Bell size={14} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 text-sm font-bold">Notifications</span>
            <button type="button" onClick={onClose} aria-label="Close notifications" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]">
              Close
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <div className="space-y-2 text-sm">
            <div role="status" className="flex items-start gap-2.5 rounded-[18px] border border-[var(--inner-border)] bg-[var(--hover)] p-3.5">
              <span className={cn("mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full", state === "offline" || state === "unavailable" || state === "forbidden" ? "bg-[var(--red-soft,rgba(255,69,58,0.12))] text-[var(--red)]" : state === "ready" && !isStale ? "bg-[var(--green-soft,rgba(48,209,88,0.12))] text-[var(--green)]" : "bg-[var(--status-warning-soft,rgba(255,159,10,0.12))] text-[var(--status-warning)]")}>
                <span className={cn("h-2 w-2 rounded-full", state === "offline" || state === "unavailable" || state === "forbidden" ? "bg-[var(--red)]" : state === "ready" && !isStale ? "bg-[var(--green)]" : "animate-pulse bg-[var(--status-warning)]")} />
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-[var(--text-1)]">{statusTitle}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-2)]">{state === "forbidden" ? "The current session is not authorized to read dashboard health." : state === "offline" || state === "unavailable" ? "The dashboard could not reach a usable health contract." : isStale ? "Showing the last safe response while the daemon recovers." : state === "ready" ? "Live status from this Cartethyia instance." : "The daemon has not supplied enough evidence to claim readiness."}</p>
              </div>
            </div>
            {updateAvailable ? (
              <>
                {releaseUpdateAvailable && (
                  <div className="rounded-[18px] border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5">
                    <p className="font-semibold text-[var(--accent)]">Release update available</p>
                    <p className="mt-0.5 text-xs text-[var(--text-2)]">GitHub has {latestTag ? `v${latestTag}` : "a newer release"} available.</p>
                  </div>
                )}
                {repositoryUpdates.map((branch) => (
                  <a key={branch.branch} href={branch.url} target="_blank" rel="noreferrer" className="block rounded-[18px] border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5 transition-colors hover:bg-[var(--active-pill)]">
                    <p className="font-semibold text-[var(--accent)]">{branch.branch} repository update</p>
                    <p className="mt-0.5 text-xs text-[var(--text-2)]">A newer commit is available on the {branch.branch} branch.</p>
                  </a>
                ))}
              </>
            ) : (
              <p className="px-1 py-2.5 text-center text-xs text-[var(--text-3)]">No new notifications.</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const items = useMemo(() => NAV_GROUPS.flatMap((group) => group.items), []);
  const filtered = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="Command Palette">
      <Input
        autoFocus
        placeholder="Go to page…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && filtered[0]) {
            navigate(filtered[0].to);
            onClose();
          }
        }}
      />
      <div className="mt-3 flex flex-col gap-1">
        {filtered.map((item) => (
          <button
            key={item.to}
            type="button"
            onClick={() => {
              navigate(item.to);
              onClose();
            }}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
          >
            <item.icon size={15} aria-hidden="true" />
            {item.label}
          </button>
        ))}
        {filtered.length === 0 && <p className="px-2 py-3 text-sm text-[var(--text-3)]">No matches.</p>}
      </div>
    </Dialog>
  );
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [adminName, setAdminName] = useState(() => localStorage.getItem("cartethyia.adminName") ?? "Admin");
  const [adminNameDraft, setAdminNameDraft] = useState(adminName);
  const [editingAdminName, setEditingAdminName] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const sidebarNavigation = useSidebarNavigation(location.pathname, ADVANCED_PATHS);
  const { page: sidebarPage, switchPage: switchSidebarPage } = sidebarNavigation;
  const { onPointerDown, onPointerMove, onPointerUp, onPointerLeave } = sidebarNavigation;

  const fullPath = location.pathname.replace(/\/$/, "") || "/overview";
  // Try exact match, then pattern match (replace last segment with :param).
  const segments = fullPath.split("/").filter(Boolean);
  const patternKey = segments.length >= 2 ? `/${segments.slice(0, -1).join("/")}/:toolId` : fullPath;
  const pathKey = TITLES[fullPath] !== undefined
    ? fullPath
    : TITLES[patternKey] !== undefined
      ? patternKey
      : `/${segments[0] ?? "overview"}`;
  const meta = TITLES[pathKey] ?? { title: "Cartethyia", sub: "Internal console", mobileSub: "Internal console" };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    toast.dismiss();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const selector = "aside a, aside button, aside input";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      (previous ?? menuButtonRef.current)?.focus();
    };
  }, [drawerOpen]);

  // Daemon dashboard is the single health contract; no legacy health endpoint is queried.
  const appearanceQuery = useQuery({
    queryKey: qk.settings.all,
    queryFn: () => daemonGet<AppearanceSettingsResponse>("/settings"),
    staleTime: 30_000,
  });
  const statusQuery = useDashboardHealth();
  const localVersion = statusQuery.data?.version;
  const latestTag: string | undefined = undefined;
  const releaseUpdateAvailable = false;
  const repositoryUpdates: readonly RepositoryBranchUpdate[] = [];
  const updateAvailable = false;

  const sidebar = useMemo(() => (
    <aside
      className={cn(
        "sidebar-drawer glass scrollbar-fade flex h-full flex-col gap-1 overflow-y-auto rounded-[var(--radius-sidebar)] p-[18px_14px]",
        "lg:sticky lg:top-4 lg:self-start lg:h-[calc(100vh-32px)]",
        // Off-canvas offsets match the shell's p-4 so the drawer lines up with
        // the content edges instead of sitting 4px proud of them.
        "fixed top-4 bottom-4 left-4 z-70 w-[272px] lg:left-0 lg:bottom-auto"
      )}
      style={{
        transform: drawerOpen ? "translateX(0)" : "translateX(calc(-100% - 24px))",
        transition: "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)",
      }}
    >
      <div className="flex items-center gap-2.5 px-2 pb-3.5 pt-1.5">
        <img
          src={appearanceQuery.data?.settings.runtime.sidebarIconDataUrl || `${import.meta.env.BASE_URL}favicon_love.webp`}
          alt="Cartethyia"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = `${import.meta.env.BASE_URL}favicon_love.webp`;
          }}
          className="h-9 w-9 shrink-0 rounded-[11px] object-cover"
        />
        <div className="min-w-0">
          <a
            href={`https://github.com/${GITHUB_REPO}`}
            target="_blank"
            rel="noreferrer"
            className="truncate text-base font-bold leading-tight transition-colors hover:text-[var(--accent)]"
          >
            Cartethyia Router
          </a>
          <a
            href={`https://github.com/${GITHUB_REPO}/releases`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[11px] text-[var(--text-2)] transition-colors hover:text-[var(--accent)]"
            title={releaseUpdateAvailable ? `Update available on GitHub: v${latestTag}` : updateAvailable ? "Repository update available on GitHub" : "View releases on GitHub"}
          >
            v{localVersion ?? "\u2026"}
            {updateAvailable && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-soft)] px-1.5 py-[1px] text-[9.5px] font-semibold text-[var(--accent)]">
                <Rocket size={9} className="shrink-0" /> update
              </span>
            )}
          </a>
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        onPointerDown={(event) => onPointerDown(event.clientX)}
        onPointerMove={(event) => onPointerMove(event.clientX)}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <div>
          {sidebarPage === 0 ? (
            <div
              key="page-main"
              className="sidebar-page-enter sidebar-page-main absolute inset-0 flex flex-col gap-1 overflow-y-auto scrollbar-fade"
            >
              {NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">
                    {group.label}
                  </div>
                  {group.items.map((item) =>
                    item.switchTo !== undefined ? (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => switchSidebarPage(item.switchTo!)}
                        className="relative flex w-full min-w-0 items-center gap-2.5 rounded-[11px] px-2.5 py-[9px] text-[13.5px] font-medium text-[var(--text-2)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--hover)] hover:text-[var(--text-1)] active:scale-[0.98]"
                      >
                        <item.icon size={18} className="relative shrink-0" />
                        <span className="relative">{item.label}</span>
                        <ChevronRight size={14} className="relative ml-auto text-[var(--text-3)]" />
                      </button>
                    ) : (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) =>
                          cn(
                            "relative flex w-full min-w-0 items-center gap-2.5 rounded-[11px] px-2.5 py-[9px] text-[13.5px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.98]",
                            isActive ? "font-semibold text-[var(--text-1)]" : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {isActive && (
                              <span className="absolute inset-0 rounded-[11px] border border-[var(--inner-border)] bg-[var(--active-pill)] shadow-[0_2px_8px_rgba(0,0,0,0.06)]" />
                            )}
                            <item.icon size={18} className="relative shrink-0" />
                            <span className="relative">{item.label}</span>
                            {item.badge && (
                              <span className="relative ml-auto rounded-full bg-[var(--accent-soft)] px-[7px] py-0.5 text-[10.5px] font-semibold text-[var(--accent)]">
                                {item.badge}
                              </span>
                            )}
                          </>
                        )}
                      </NavLink>
                    )
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div
              key="page-advanced"
              className="sidebar-page-enter sidebar-page-advanced absolute inset-0 flex flex-col gap-1 overflow-y-auto scrollbar-fade"
            >
              <button
                type="button"
                onClick={() => switchSidebarPage(0)}
                className="relative flex w-full min-w-0 items-center gap-2.5 rounded-[11px] px-2.5 py-[9px] text-[13.5px] font-medium text-[var(--text-2)] transition-[background-color,color,transform] duration-150 hover:bg-[var(--hover)] hover:text-[var(--text-1)] active:scale-[0.98]"
              >
                <ChevronLeft size={18} className="relative shrink-0" />
                <span className="relative">Back to Main</span>
              </button>
              {ADVANCED_NAV_GROUPS.map((group) => (
                <div key={group.label}>
                  <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">
                    {group.label}
                    {group.soon && (
                      <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-[1px] text-[8.5px] font-bold tracking-normal text-[var(--accent)]">SOON</span>
                    )}
                  </div>
                  {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === "/advanced"}
                      className={({ isActive }) =>
                        cn(
                          "relative flex w-full min-w-0 items-center gap-2.5 rounded-[11px] px-2.5 py-[9px] text-[13.5px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.98]",
                          isActive ? "font-semibold text-[var(--text-1)]" : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && (
                            <span className="absolute inset-0 rounded-[11px] border border-[var(--inner-border)] bg-[var(--active-pill)] shadow-[0_2px_8px_rgba(0,0,0,0.06)]" />
                          )}
                          <item.icon size={18} className="relative shrink-0" />
                          <span className="relative">{item.label}</span>
                          {item.badge && (
                            <span className="relative ml-auto rounded-full bg-[var(--accent-soft)] px-[7px] py-0.5 text-[10.5px] font-semibold text-[var(--accent)]">
                              {item.badge}
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-auto pt-4">
        <div className="group flex items-center gap-2.5 rounded-[13px] border border-[var(--inner-border)] bg-[var(--hover)] p-[9px_10px]">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#ff9f0a] to-[#ff375f] text-xs font-bold text-white">AD</div>
          <div className="min-w-0 flex-1">
            {editingAdminName ? (
              <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); const next = adminNameDraft.trim() || "Admin"; setAdminName(next); localStorage.setItem("cartethyia.adminName", next); setEditingAdminName(false); }}>
                <button type="submit" aria-label="Save admin name" title="Save" className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--green)] hover:bg-[var(--active-pill)]"><Check size={14} /></button>
              </form>
            ) : (
              <button type="button" className="flex max-w-full items-center gap-1 text-left" onClick={() => { setAdminNameDraft(adminName); setEditingAdminName(true); }}>
                <span className="truncate text-[13px] font-semibold leading-tight">{adminName}</span><Pencil size={11} className="shrink-0 text-[var(--text-3)] opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            <div className="text-[11px] text-[var(--text-2)]">Cartethyia console</div>
          </div>
          <button onClick={() => { void daemonPost("/auth/logout").finally(() => navigate("/login", { replace: true })); }} aria-label="Logout" title="Logout" className="grid size-8 place-items-center rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--red)]"><LogOut size={15} /></button>
        </div>
      </div>
    </aside>
  ), [drawerOpen, sidebarPage, switchSidebarPage, appearanceQuery.data?.settings.runtime.sidebarIconDataUrl, localVersion, updateAvailable, releaseUpdateAvailable, latestTag, adminName, adminNameDraft, editingAdminName]);

  return (
    <>
      <CustomAtmosphere />
      <div className="relative z-10 mx-auto grid min-h-dvh max-w-[1560px] grid-cols-1 gap-4 p-4 lg:grid-cols-[272px_minmax(0,1fr)]">
      {drawerOpen && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-60 cursor-default bg-black/30 backdrop-blur-[4px] lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      {sidebar}

      <div className={cn("flex min-h-0 min-w-0 flex-col gap-4", pathKey === "/console-log" && "h-dvh overflow-hidden")}>
        <header className={cn("glass z-40 flex items-center gap-2 rounded-[18px] px-3 py-2.5 sm:gap-3.5 sm:px-4 sm:py-3", pathKey === "/console-log" ? "static" : "sticky top-4")}>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] transition-[background-color,color,transform] active:scale-95 lg:hidden"
          >
            <Menu size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-bold tracking-tight sm:text-[17px]">{meta.title}</h1>
            <p className="truncate text-[10.5px] text-[var(--text-2)] sm:hidden">{meta.mobileSub}</p>
            <p className="hidden truncate text-xs text-[var(--text-2)] sm:block">{meta.sub}</p>
          </div>
          <ThemeToggle />
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setNotificationsOpen((current) => !current)}
              aria-label="Open notifications"
              aria-expanded={notificationsOpen}
              aria-haspopup="dialog"
              className="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] transition-[background-color,color,transform] hover:bg-[var(--active-pill)] active:scale-90"
            >
              <Bell size={17} />
            </button>
            <NotificationsDialog open={notificationsOpen} onClose={() => setNotificationsOpen(false)} state={statusQuery.state} isStale={statusQuery.isStale} updateAvailable={updateAvailable} releaseUpdateAvailable={releaseUpdateAvailable} latestTag={latestTag} repositoryUpdates={repositoryUpdates} />
          </div>
        </header>

        {/* `flex-1 min-h-0` lets a page opt into filling the remaining
            space between the sticky header and footer (e.g. Console Log's
            `h-full` root) instead of the old `max-h-[calc(100vh-Npx)]`
            magic-number hack; pages that don't opt in render at their
            natural content height exactly as before \u2014 a column flex
            child's main-axis size stays content-driven unless it sets its
            own `flex-1`/`h-full`. */}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div key={location.pathname} className="route-enter flex min-h-0 min-w-0 flex-1 flex-col gap-4">
            <Outlet />
          </div>
        </main>

        <div><FooterClock statusData={statusQuery.data} state={statusQuery.state} isStale={statusQuery.isStale} /></div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </>
  );
}
