import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  Boxes,
  Cable,
  ChartSpline,
  Clock,
  Filter,
  Globe,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Rocket,
  Search,
  Settings,
  Sun,
  Terminal,
  Timer,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { cn } from "../lib/cn";
import { apiGet, apiPost } from "../lib/api";
import { formatUptime } from "../lib/format";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";

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
function FooterClock({ statusData }: { statusData: HealthStatus | undefined }) {
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
    <footer className="glass sticky bottom-4 z-30 mt-auto grid grid-cols-2 items-center gap-x-4 gap-y-1.5 rounded-2xl px-4 py-3 text-xs text-[var(--text-2)] sm:gap-x-8 sm:px-5 sm:py-3.5">
      <div className="flex items-center gap-1.5 font-semibold text-[var(--text-1)]">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--green)]" />
        All systems operational
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
      { to: "/usage", label: "Usage", icon: ChartSpline, badge: "live" },
      { to: "/providers", label: "Providers", icon: Cable },
    ],
  },
  {
    label: "Control",
    items: [
      { to: "/combos", label: "Combos", icon: Layers },
      { to: "/proxy-pools", label: "Proxy Pools", icon: Globe },
      { to: "/filter-rules", label: "Filter Rules", icon: Filter },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/console-log", label: "Console Log", icon: Terminal },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const TITLES: Record<string, { title: string; sub: string }> = {
  "/overview": { title: "Overview", sub: "Traffic, endpoint, dan API key" },
  "/usage": { title: "Usage", sub: "Usage + requests dalam satu halaman" },
  "/providers": { title: "Providers", sub: "Kimchi, Command Code, OpenCode, Devin, Qoder, MiMo" },
  "/combos": { title: "Combos & Alias", sub: "Fallback, round-robin, alias model" },
  "/proxy-pools": { title: "Proxy Pools", sub: "HTTP, HTTPS, SOCKS5" },
  "/filter-rules": { title: "Filter Rules", sub: "Sanitize client-identity text before dispatch" },
  "/console-log": { title: "Console Log", sub: "Live log stream" },
  "/settings": { title: "Settings", sub: "Security, backup, runtime toggles" },
};

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

    if (!startViewTransition || reduced) {
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
  const pathKey = `/${location.pathname.split("/").filter(Boolean)[0] ?? "overview"}`;
  const meta = TITLES[pathKey] ?? { title: "Cartethyia", sub: "Internal console" };

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
        "glass flex h-full flex-col gap-1.5 overflow-y-auto rounded-[var(--radius-sidebar)] p-[18px_14px]",
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
          <div className="px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">
            {group.label}
          </div>
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "relative flex items-center gap-2.5 rounded-[11px] border border-transparent px-2.5 py-[9px] text-[13.5px] font-medium text-[var(--text-2)] transition-all duration-150 hover:bg-[var(--hover)] hover:text-[var(--text-1)] active:scale-[0.98]",
                  isActive &&
                    "border-[var(--inner-border)] bg-[var(--active-pill)] font-semibold text-[var(--text-1)] shadow-[0_2px_8px_rgba(0,0,0,0.06)]"
                )
              }
            >
              <item.icon size={18} className="shrink-0" />
              {item.label}
              {item.badge && (
                <span className="ml-auto rounded-full bg-[var(--accent-soft)] px-[7px] py-0.5 text-[10.5px] font-semibold text-[var(--accent)]">
                  {item.badge}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}

      <div className="mt-auto pt-3">
        <div className="flex items-center gap-2.5 rounded-[13px] border border-[var(--inner-border)] bg-[var(--hover)] p-[9px_10px]">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#ff9f0a] to-[#ff375f] text-xs font-bold text-white">
            AD
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-tight">Admin</div>
            <div className="text-[11px] text-[var(--text-2)]">role: admin · JWT</div>
          </div>
          <button
            onClick={() => {
              void apiPost("/logout").finally(() => navigate("/login", { replace: true }));
            }}
            aria-label="Logout"
            title="Logout"
            className="ml-auto grid place-items-center rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--red)]"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="mx-auto grid min-h-screen max-w-[1560px] grid-cols-1 gap-4 p-4 lg:grid-cols-[272px_minmax(0,1fr)]">
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
          <div className="min-w-0 shrink-0 max-w-28 sm:max-w-none">
            <h1 className="truncate text-[15px] font-bold tracking-tight sm:text-[17px]">{meta.title}</h1>
            <p className="hidden truncate text-xs text-[var(--text-2)] sm:block">{meta.sub}</p>
          </div>
          <button
            onClick={() => setPaletteOpen(true)}
            className="ml-auto flex min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-1.5 text-[12px] text-[var(--text-3)] transition-colors hover:border-[var(--accent)] sm:w-60 sm:flex-none sm:gap-2 sm:px-3 sm:py-2 sm:text-[13px]"
          >
            <Search size={15} />
            <span className="truncate">Search…</span>
            <kbd className="ml-auto hidden rounded-md bg-[var(--kbd-bg)] px-1.5 py-0.5 text-[10.5px] font-semibold sm:inline">⌘K</kbd>
          </button>
          <ThemeToggle />
          <button
            aria-label="Notifications"
            className="hidden h-9.5 w-9.5 place-items-center rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] transition-all hover:bg-[var(--active-pill)] active:scale-90 sm:grid"
          >
            <Bell size={17} />
          </button>
        </header>

        <main className="flex min-w-0 flex-col gap-4">
          <Outlet />
        </main>

        {/* `mt-auto` drops it to the bottom on short pages; `sticky bottom-4`
            keeps it parked there while long pages scroll behind it. */}
        <FooterClock statusData={statusQuery.data} />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
