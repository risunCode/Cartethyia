import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  Boxes,
  Cable,
  ChartSpline,
  Clock,
  Globe,
  Gauge,
  Layers,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Menu,
  Moon,
  Palette,
  Pencil,
  Check,
  Rocket,
  Settings,
  SlidersHorizontal,
  Sun,
  Terminal,
  Timer,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation, useNavigate, useOutlet } from "react-router-dom";
import { useTheme } from "next-themes";
import { cn } from "../lib/cn";
import { pageTransition } from "../lib/motion";
import { apiGet, apiPost } from "../lib/api";
import { formatUptime } from "../lib/format";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { CustomAtmosphere } from "../features/customization/background";

interface HealthStatus {
  version: string;
  startedAt: number;
  uptimeSeconds: number;
  now: number;
  timezoneOffsetMinutes: number;
}

const GITHUB_REPO = "risunCode/Cartethyia";

// ---------------------------------------------------------------------------
// FooterClock — isolated so the 1-second tick never re-renders AppShell or
// any page inside <Outlet />.
// ---------------------------------------------------------------------------
function FooterClock({ statusData, isError }: { statusData: HealthStatus | undefined; isError: boolean }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const clockOffsetRef = useRef(0);
  const tzOffsetRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!statusData) return;
    clockOffsetRef.current = statusData.now - Date.now();
    tzOffsetRef.current = statusData.timezoneOffsetMinutes;
    startedAtRef.current = statusData.startedAt;
  }, [statusData]);

  const serverNowMs = nowMs + clockOffsetRef.current;
  const serverNow = new Date(serverNowMs);
  const serverLocalNow = new Date(serverNowMs - tzOffsetRef.current * 60_000);
  const liveUptimeSeconds = startedAtRef.current !== null
    ? (serverNowMs - startedAtRef.current) / 1000
    : null;

  const fmt = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false });

  return (
    <footer className="glass z-30 mt-auto grid w-full grid-cols-2 items-center gap-x-4 gap-y-1.5 rounded-2xl px-4 py-3 text-xs text-[var(--text-2)] sm:gap-x-8 sm:px-5 sm:py-3.5">
      <div className="flex items-center gap-1.5 font-semibold text-[var(--text-1)]">
        {isError ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--red)]" />
            System offline
          </>
        ) : statusData ? (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--green)]" />
            All systems operational
          </>
        ) : (
          <>
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--yellow,theme(colors.amber.400))]" />
            Connecting…
          </>
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5" title="UTC time">
        <Globe size={13} className="shrink-0" />
        {fmt(serverNow)} UTC
      </div>
      <div className="flex items-center gap-1.5" title="Server system time">
        <Clock size={13} className="shrink-0" />
        {fmt(serverLocalNow)} system
      </div>
      <div className="flex items-center justify-end gap-1.5" title="Uptime since server start">
        <Timer size={13} className="shrink-0" />
        uptime {formatUptime(liveUptimeSeconds)}
      </div>
    </footer>
  );
}

interface NavEntry {
  to: string;
  label: string;
  icon: typeof Boxes;
  badge?: string;
}

const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "Main",
    items: [
      { to: "/overview", label: "Overview", icon: LayoutDashboard },
      { to: "/usage", label: "Usage", icon: ChartSpline },
      { to: "/providers", label: "Providers", icon: Cable },
      { to: "/model-studio", label: "Model Studio", icon: MessageSquare },
    ],
  },
  {
    label: "Control",
    items: [
      { to: "/combos", label: "Combos", icon: Layers },
      { to: "/quota", label: "Quota Management", icon: Gauge },
      { to: "/proxy-requests", label: "Proxy & Requests", icon: SlidersHorizontal },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/console-log", label: "Console Log", icon: Terminal },
      { to: "/customization", label: "Customization", icon: Palette },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const TITLES: Record<string, { title: string; sub: string; mobileSub: string }> = {
  "/overview": { title: "Overview", sub: "Traffic, endpoints, and API keys", mobileSub: "Traffic & API keys" },
  "/usage": { title: "Usage", sub: "Usage summary and request overview", mobileSub: "Request activity" },
  "/providers": { title: "Providers", sub: "All supported AI providers", mobileSub: "All AI providers" },
  "/model-studio": { title: "Model Studio", sub: "Chat-test any provider, model, or combo live", mobileSub: "Test models live" },
  "/combos": { title: "Combos & Alias", sub: "Fallback, round-robin, alias model", mobileSub: "Fallback & aliases" },
  "/quota": { title: "Quota Management", sub: "Provider account limits and reset windows", mobileSub: "Quota & resets" },
  "/proxy-requests": { title: "Proxy & Requests", sub: "Routing and request policy controls", mobileSub: "Proxy controls" },
  "/console-log": { title: "Console Log", sub: "Live log stream", mobileSub: "Live log stream" },
  "/customization": { title: "Customization", sub: "Theme and cosmetic preferences", mobileSub: "Theme preferences" },
  "/settings": { title: "Settings", sub: "Security, backup, runtime toggles", mobileSub: "Security & runtime" },
};

/**
 * `<Outlet />` re-renders reactively off router context the instant
 * `location` changes, which fights a key-based AnimatePresence: the
 * *outgoing* motion.div (still mounted, mid-exit) would swap to the *new*
 * route's content underneath its exit animation, leaving the freshly
 * navigated page stuck invisible at the exit's final opacity/scale until a
 * hard refresh. Freezing the resolved element in state (computed once per
 * mount, since the initializer only runs on first render) keeps the exiting
 * instance showing its own page while a separate, freshly keyed instance
 * renders the new one.
 */
function AnimatedOutlet() {
  const outlet = useOutlet();
  const [frozen] = useState(outlet);
  return frozen;
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  // Circular reveal from wherever the toggle was pressed. View Transitions
  // snapshots the old frame, so the new theme can be wiped in over it; without
  // support (or with reduced motion) the theme just swaps instantly.
  const swapTheme = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const next = dark ? "light" : "dark";
    const startViewTransition = document.startViewTransition?.bind(document);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

    if (!startViewTransition || reduced || coarsePointer) {
      setTheme(next);
      return;
    }

    const { top, left, width, height } = event.currentTarget.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));

    const root = document.documentElement;
    root.style.setProperty("--theme-wipe-x", `${x}px`);
    root.style.setProperty("--theme-wipe-y", `${y}px`);
    root.style.setProperty("--theme-wipe-r", `${radius}px`);
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
      className="grid h-9.5 w-9.5 place-items-center rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-1)] transition-all duration-150 hover:bg-[var(--active-pill)] active:scale-90"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={dark ? "sun" : "moon"}
          initial={{ opacity: 0, rotate: -60, scale: 0.7 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 60, scale: 0.7 }}
          transition={{ duration: 0.2 }}
          className="grid place-items-center"
        >
          {dark ? <Sun size={17} /> : <Moon size={17} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function NotificationsDialog({
  open,
  onClose,
  statusData,
  isHealthError,
  updateAvailable,
  latestTag,
}: {
  open: boolean;
  onClose: () => void;
  statusData: HealthStatus | undefined;
  isHealthError: boolean;
  updateAvailable: boolean;
  latestTag: string | undefined;
}) {
  if (!open) return null;
  return (
    <div role="dialog" aria-label="Notifications" className="absolute right-0 top-[calc(100%+10px)] z-50 w-[min(320px,calc(100vw-2rem))] rounded-2xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)] p-3 shadow-[0_18px_45px_rgba(0,0,0,0.25)] backdrop-blur-xl">
      <div className="mb-2 flex items-center justify-between px-1"><span className="text-sm font-bold">Notifications</span><button type="button" onClick={onClose} aria-label="Close notifications" className="text-xs text-[var(--text-3)] hover:text-[var(--text-1)]">Close</button></div>
      <div className="space-y-2 text-sm">
        <div className="flex items-start gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
          <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", isHealthError ? "bg-[var(--red)]" : statusData ? "bg-[var(--green)]" : "animate-pulse bg-[var(--yellow,theme(colors.amber.400))]")} />
          <div>
            <p className="font-semibold text-[var(--text-1)]">{isHealthError ? "System status unavailable" : statusData ? "All systems operational" : "Checking system status"}</p>
            <p className="mt-0.5 text-xs text-[var(--text-2)]">{isHealthError ? "The dashboard could not reach the local health endpoint." : "Live status from this Cartethyia instance."}</p>
          </div>
        </div>
        {updateAvailable ? (
          <div className="rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3">
            <p className="font-semibold text-[var(--accent)]">Update available</p>
            <p className="mt-0.5 text-xs text-[var(--text-2)]">GitHub has {latestTag ? `v${latestTag}` : "a newer release"} available.</p>
          </div>
        ) : (
          <p className="px-1 py-2 text-center text-xs text-[var(--text-3)]">No new notifications.</p>
        )}
      </div>
    </div>
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
            onClick={() => {
              navigate(item.to);
              onClose();
            }}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--text-2)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
          >
            <item.icon size={15} />
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [adminName, setAdminName] = useState(() => localStorage.getItem("cartethyia.adminName") ?? "Admin");
  const [adminNameDraft, setAdminNameDraft] = useState(adminName);
  const [editingAdminName, setEditingAdminName] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [isStudioComposerFocused, setIsStudioComposerFocused] = useState(false);
  const [isCompactMotion, setIsCompactMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px), (prefers-reduced-motion: reduce)");
    const update = () => setIsCompactMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const onFocusChange = () => setIsStudioComposerFocused(document.activeElement?.matches("[data-model-studio-composer]") ?? false);
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    return () => {
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
    };
  }, []);
  const pathKey = `/${location.pathname.split("/").filter(Boolean)[0] ?? "overview"}`;
  const meta = TITLES[pathKey] ?? { title: "Cartethyia", sub: "Internal console", mobileSub: "Internal console" };
  const routeTransition = isCompactMotion
    ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 1 }, transition: { duration: 0 } }
    : pageTransition;

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

  // Server clock (not the browser's) drives "system time"; refetched
  // periodically and interpolated locally by the 1s `now` ticker above.
  const statusQuery = useQuery({
    queryKey: ["health-status"],
    queryFn: () => apiGet<HealthStatus>("/health/status"),
    refetchInterval: 30_000,
  });
  const releaseQuery = useQuery({
    queryKey: ["github-latest-release"],
    queryFn: async () => {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      return (await res.json()) as { tag_name: string; html_url: string };
    },
    staleTime: 30 * 60_000,
    retry: false,
  });
  const localVersion = statusQuery.data?.version;
  const latestTag = releaseQuery.data?.tag_name?.replace(/^v/, "");
  const updateAvailable = Boolean(localVersion && latestTag && latestTag !== localVersion);

  const sidebar = (
    <aside
      className={cn(
        "glass scrollbar-none flex h-full flex-col gap-1 overflow-y-auto rounded-[var(--radius-sidebar)] p-[18px_14px]",
        "lg:sticky lg:top-4 lg:h-[calc(100vh-32px)] lg:translate-x-0",
        // Off-canvas offsets match the shell's p-4 so the drawer lines up with
        // the content edges instead of sitting 4px proud of them.
        "fixed top-4 bottom-4 left-4 z-70 w-[272px] transition-transform duration-300",
        drawerOpen ? "translate-x-0" : "-translate-x-[calc(100%+24px)] lg:translate-x-0"
      )}
    >
      <div className="flex items-center gap-2.5 px-2 pb-3.5 pt-1.5">
        <img
          src={`${import.meta.env.BASE_URL}cartethyia-sidebar.gif`}
          alt="Cartethyia"
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
            href={releaseQuery.data?.html_url ?? `https://github.com/${GITHUB_REPO}/releases`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[11px] text-[var(--text-2)] transition-colors hover:text-[var(--accent)]"
            title={updateAvailable ? `Update available on GitHub: v${latestTag}` : "View releases on GitHub"}
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

      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">
            {group.label}
          </div>
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "relative flex items-center gap-2.5 rounded-[11px] px-2.5 py-[9px] text-[13.5px] font-medium transition-colors duration-150 active:scale-[0.98]",
                  isActive ? "font-semibold text-[var(--text-1)]" : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active-pill"
                      className="absolute inset-0 rounded-[11px] border border-[var(--inner-border)] bg-[var(--active-pill)] shadow-[0_2px_8px_rgba(0,0,0,0.06)]"
                      transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    />
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

      <div className="pt-2">
        <div className="group flex items-center gap-2.5 rounded-[13px] border border-[var(--inner-border)] bg-[var(--hover)] p-[9px_10px]">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#ff9f0a] to-[#ff375f] text-xs font-bold text-white">AD</div>
          <div className="min-w-0 flex-1">
            {editingAdminName ? (
              <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); const next = adminNameDraft.trim() || "Admin"; setAdminName(next); localStorage.setItem("cartethyia.adminName", next); setEditingAdminName(false); }}>
                <Input autoFocus value={adminNameDraft} onChange={(event) => setAdminNameDraft(event.target.value)} aria-label="Admin display name" className="h-7 min-w-0 px-2 text-xs" />
                <button type="submit" aria-label="Save admin name" title="Save" className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--green)] hover:bg-[var(--active-pill)]"><Check size={14} /></button>
              </form>
            ) : (
              <button type="button" className="flex max-w-full items-center gap-1 text-left" onClick={() => { setAdminNameDraft(adminName); setEditingAdminName(true); }}>
                <span className="truncate text-[13px] font-semibold leading-tight">{adminName}</span><Pencil size={11} className="shrink-0 text-[var(--text-3)] opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            <div className="text-[11px] text-[var(--text-2)]">Cartethyia console</div>
          </div>
          <button onClick={() => { void apiPost("/logout").finally(() => navigate("/login", { replace: true })); }} aria-label="Logout" title="Logout" className="grid place-items-center rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--red)]"><LogOut size={15} /></button>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      <CustomAtmosphere />
      <div className="relative z-10 mx-auto grid min-h-dvh max-w-[1560px] grid-cols-1 gap-4 p-4 lg:grid-cols-[272px_minmax(0,1fr)]">
      {drawerOpen && (
        <div
          className="fixed inset-0 z-60 bg-black/30 backdrop-blur-[4px] lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      {sidebar}

      <div className="flex min-w-0 flex-col gap-4">
        <header className="glass sticky top-4 z-40 flex items-center gap-2 rounded-[18px] px-3 py-2.5 sm:gap-3.5 sm:px-4 sm:py-3">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] lg:hidden sm:h-9.5 sm:w-9.5"
          >
            <Menu size={18} />
          </button>
          <img
            src={`${import.meta.env.BASE_URL}cartethyia-sidebar.gif`}
            alt="Cartethyia"
            className="h-7 w-7 shrink-0 rounded-[9px] object-cover sm:h-8 sm:w-8 sm:rounded-[10px]"
          />
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
              className="grid h-9 w-9 place-items-center rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] transition-all hover:bg-[var(--active-pill)] active:scale-90 sm:h-9.5 sm:w-9.5"
            >
              <Bell size={17} />
            </button>
            <NotificationsDialog open={notificationsOpen} onClose={() => setNotificationsOpen(false)} statusData={statusQuery.data} isHealthError={statusQuery.isError} updateAvailable={updateAvailable} latestTag={latestTag} />
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
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={location.pathname} {...routeTransition} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
              <AnimatedOutlet />
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Normal flow footer: `mt-auto` drops it to the bottom on short pages. */}
        {pathKey !== "/model-studio" && <div className={cn(isStudioComposerFocused && "hidden sm:block")}><FooterClock statusData={statusQuery.data} isError={statusQuery.isError} /></div>}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </>
  );
}
