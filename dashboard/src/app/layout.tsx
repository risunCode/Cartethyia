import { AnimatePresence, m } from "framer-motion";
import {
  Bell,
  Boxes,
  Cable,
  ChartSpline,
  ChevronLeft,
  ChevronRight,
  Clock,
  Globe,
  Gauge,
  Layers,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Menu,
  Moon,
  Pencil,
  Check,
  Rocket,
  Settings,
  Coins,
  Database,
  Filter,
  SlidersHorizontal,
  Sun,
  TerminalSquare,
  Workflow,
  Terminal,
  Timer,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useLocation, useNavigate, useOutlet } from "react-router-dom";
import { useTheme } from "next-themes";
import { cn } from "../lib/cn";
import { detectMotionProfile, getPageTransition, getPopoverMotion, MOTION_OVERRIDE_EVENT, useMotionProfile, type MotionProfile } from "../lib/motion";
import { apiGet, apiPost } from "../lib/api";
import { qk } from "../lib/query-keys";
import { formatUptime } from "../lib/format";
import { toast } from "../lib/toast";
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
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--status-warning)]" />
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
  /** When set, clicking this entry switches the sidebar page instead of navigating. */
  switchTo?: 0 | 1;
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
      { to: "", label: "Advanced Features", icon: SlidersHorizontal, switchTo: 1 },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const ADVANCED_NAV_GROUPS: { label: string; items: NavEntry[]; soon?: boolean }[] = [
  {
    label: "General",
    items: [
      { to: "/advanced", label: "Customization", icon: SlidersHorizontal },
      { to: "/advanced/warp", label: "MultiWarp", icon: Globe },
      { to: "/advanced/filter-sanitize", label: "Filter Sanitize", icon: Filter },
      { to: "/advanced/token-saver", label: "Token Saver", icon: Coins },
      { to: "/advanced/cli-tools", label: "CLI Tools", icon: TerminalSquare },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/advanced/db-map", label: "Database Map", icon: Database },
    ],
  },
  {
    label: "Tools",
    items: [
      { to: "/advanced/automation", label: "Automation", icon: Workflow, badge: "Soon" },
    ],
  },
];

const ADVANCED_PATHS = new Set(["/advanced", ...ADVANCED_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to))]);

const TITLES: Record<string, { title: string; sub: string; mobileSub: string }> = {
  "/overview": { title: "Overview", sub: "Traffic, endpoints, and fast shortcuts", mobileSub: "Traffic & shortcuts" },
  "/usage": { title: "Usage", sub: "Usage summary and request overview", mobileSub: "Request activity" },
  "/providers": { title: "Providers", sub: "All supported AI providers", mobileSub: "All AI providers" },
  "/model-studio": { title: "Model Studio", sub: "Chat-test any provider, model, or combo live", mobileSub: "Test models live" },
  "/api-keys": { title: "API Keys", sub: "Client credentials and access policies", mobileSub: "Client credentials" },
  "/combos": { title: "Combos & Alias", sub: "Fallback, round-robin, alias model", mobileSub: "Fallback & aliases" },
  "/quota": { title: "Quota Management", sub: "Provider account limits and reset windows", mobileSub: "Quota & resets" },
  "/proxy-requests": { title: "Proxy & Requests", sub: "Routing and request policy controls", mobileSub: "Proxy controls" },
  "/console-log": { title: "Console Log", sub: "Live log stream", mobileSub: "Live log stream" },
  "/advanced": { title: "Customization", sub: "Background, sidebar icon, and appearance controls", mobileSub: "Appearance" },
  "/advanced/filter-sanitize": { title: "Filter Sanitize", sub: "Reasoning tag stripping and response content filtering", mobileSub: "Filter" },
  "/advanced/token-saver": { title: "Token Saver", sub: "Reduce token usage with compact encoding and caching", mobileSub: "Tokens" },
  "/advanced/warp": { title: "MultiWarp", sub: "Cloudflare Warp account pool and egress instances", mobileSub: "Warp pool" },
  "/advanced/cli-tools": { title: "CLI Tools", sub: "Configure CLI tools for terminal access", mobileSub: "CLI config" },
  "/advanced/cli-tools/:toolId": { title: "CLI Tool", sub: "Tool configuration", mobileSub: "Tool config" },
  "/settings": { title: "Settings", sub: "Security, backup, runtime toggles", mobileSub: "Security & runtime" },
};

/**
 * `<Outlet />` re-renders reactively off router context the instant
 * `location` changes, which fights a key-based AnimatePresence: the
 * *outgoing* m.div (still mounted, mid-exit) would swap to the *new*
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
  // Crossfade the next theme snapshot without repainting the full glass surface.
  // Without View Transitions (or with reduced motion) the theme swaps instantly.
  const swapTheme = () => {
    const next = dark ? "light" : "dark";
    const startViewTransition = document.startViewTransition?.bind(document);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

    if (!startViewTransition || reduced || coarsePointer) {
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
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const popupMotion = getPopoverMotion(useMotionProfile());
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
  return (
    <AnimatePresence>
      {open && (
        <m.div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Notifications"
          tabIndex={-1}
          className="absolute right-0 top-[calc(100%+16px)] z-50 max-h-[calc(100dvh-120px)] w-[min(360px,calc(100vw-2rem))] origin-top-right overflow-auto rounded-[20px] border border-[var(--inner-border)] bg-[var(--bg-1)] p-2.5 shadow-[0_24px_60px_rgba(0,0,0,0.35)] sm:right-0 sm:w-[360px]"
          {...popupMotion}
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
              <span className={cn("mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full", isHealthError ? "bg-[var(--red-soft,rgba(255,69,58,0.12))] text-[var(--red)]" : statusData ? "bg-[var(--green-soft,rgba(48,209,88,0.12))] text-[var(--green)]" : "bg-[var(--status-warning-soft,rgba(255,159,10,0.12))] text-[var(--status-warning)]")}>
                <span className={cn("h-2 w-2 rounded-full", isHealthError ? "bg-[var(--red)]" : statusData ? "bg-[var(--green)]" : "animate-pulse bg-[var(--status-warning)]")} />
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-[var(--text-1)]">{isHealthError ? "System status unavailable" : statusData ? "All systems operational" : "Checking system status"}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-2)]">{isHealthError ? "The dashboard could not reach the local health endpoint." : "Live status from this Cartethyia instance."}</p>
              </div>
            </div>
            {updateAvailable ? (
              <div className="rounded-[18px] border border-[var(--accent)] bg-[var(--accent-soft)] p-3.5">
                <p className="font-semibold text-[var(--accent)]">Update available</p>
                <p className="mt-0.5 text-xs text-[var(--text-2)]">GitHub has {latestTag ? `v${latestTag}` : "a newer release"} available.</p>
              </div>
            ) : (
              <p className="px-1 py-2.5 text-center text-xs text-[var(--text-3)]">No new notifications.</p>
            )}
          </div>
        </m.div>
      )}
    </AnimatePresence>
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
  const [isStudioComposerFocused, setIsStudioComposerFocused] = useState(false);
  const [motionProfile, setMotionProfile] = useState<MotionProfile>(() => detectMotionProfile());

  // ── Sidebar page (Main ↔ Advanced sliding launcher) ────────────────
  // State persists in localStorage so closing the drawer (mobile burger)
  // and reopening it doesn't reset to page 0. A direct navigation to an
  // advanced route also flips to page 1 automatically.
  const swipeStartX = useRef<number | null>(null);
  const swipeDelta = useRef<number | null>(null);
  const swipeActive = useRef(false);
  const [sidebarPage, setSidebarPage] = useState<0 | 1>(() => {
    const stored = localStorage.getItem("cartethyia.sidebarPage");
    return stored === "1" ? 1 : 0;
  });
  const switchSidebarPage = useCallback((page: 0 | 1) => {
    setSidebarPage(page);
    localStorage.setItem("cartethyia.sidebarPage", String(page));
  }, []);
  // Auto-switch to page 1 when navigating to an advanced route.
  // Skips the very first run (initial mount) so a refresh on an advanced
  // route doesn't override the user's explicit "Back to Main" choice —
  // localStorage is the source of truth at mount; this effect only kicks
  // in on *subsequent* navigations (clicking a link / browser back).
  const sidebarPageFirstRun = useRef(true);
  useEffect(() => {
    if (sidebarPageFirstRun.current) {
      sidebarPageFirstRun.current = false;
      return;
    }
    const pathKey = `/${location.pathname.split("/").filter(Boolean)[0] ?? "overview"}`;
    if (ADVANCED_PATHS.has(pathKey)) {
      setSidebarPage(1);
      localStorage.setItem("cartethyia.sidebarPage", "1");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);
  useEffect(() => {
    const mediaQueries = [
      window.matchMedia("(max-width: 767px)"),
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(prefers-reduced-motion: reduce)"),
    ];
    const update = () => {
      const nextProfile = detectMotionProfile();
      setMotionProfile(nextProfile);
      document.documentElement.dataset.motionProfile = nextProfile;
    };
    update();
    for (const media of mediaQueries) media.addEventListener("change", update);
    window.addEventListener(MOTION_OVERRIDE_EVENT, update);
    return () => {
      for (const media of mediaQueries) media.removeEventListener("change", update);
      window.removeEventListener(MOTION_OVERRIDE_EVENT, update);
    };
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
  // Use the full pathname for TITLES lookup so advanced routes like
  // /advanced/filter-sanitize resolve to their specific title, not the
  // generic /advanced "Customization" entry.
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
  const routeTransition = getPageTransition(motionProfile);

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

  // Server clock (not the browser's) drives "system time"; refetched
  // periodically and interpolated locally by the 1s `now` ticker above.
  const statusQuery = useQuery({
    queryKey: qk.health.status,
    queryFn: () => apiGet<HealthStatus>("/health/status"),
    refetchInterval: 30_000,
  });
  const appearanceQuery = useQuery({
    queryKey: qk.settings.all,
    queryFn: () => apiGet<AppearanceSettingsResponse>("/settings"),
    staleTime: 30_000,
  });
  const releaseQuery = useQuery({
    queryKey: qk.releases.githubLatest,
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

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        onPointerDown={(e) => { swipeStartX.current = e.clientX; swipeActive.current = true; }}
        onPointerMove={(e) => {
          if (!swipeActive.current || swipeStartX.current === null) return;
          const delta = e.clientX - swipeStartX.current;
          swipeDelta.current = delta;
        }}
        onPointerUp={() => {
          if (!swipeActive.current || swipeDelta.current === null) { swipeActive.current = false; return; }
          const threshold = 60;
          if (swipeDelta.current <= -threshold && sidebarPage === 0) switchSidebarPage(1);
          else if (swipeDelta.current >= threshold && sidebarPage === 1) switchSidebarPage(0);
          swipeStartX.current = null;
          swipeDelta.current = null;
          swipeActive.current = false;
        }}
        onPointerLeave={() => { swipeStartX.current = null; swipeDelta.current = null; swipeActive.current = false; }}
      >
        <AnimatePresence initial={false}>
          {sidebarPage === 0 ? (
            <m.div
              key="page-main"
              initial={{ x: "-100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "-100%", opacity: 0 }}
              transition={{ duration: motionProfile === "reduced" ? 0 : motionProfile === "mobile" ? 0.2 : 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 flex flex-col gap-1 overflow-y-auto scrollbar-fade"
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
                              <m.span
                                layoutId={motionProfile === "desktop" || motionProfile === "max" ? "sidebar-active" : undefined}
                                transition={motionProfile === "max" ? { duration: 0.28, ease: "easeOut" } : { duration: 0.2, ease: "easeOut" }}
                                className="absolute inset-0 rounded-[11px] border border-[var(--inner-border)] bg-[var(--active-pill)] shadow-[0_2px_8px_rgba(0,0,0,0.06)]"
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
                    )
                  )}
                </div>
              ))}
            </m.div>
          ) : (
            <m.div
              key="page-advanced"
              initial={{ x: "100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0 }}
              transition={{ duration: motionProfile === "reduced" ? 0 : motionProfile === "mobile" ? 0.2 : 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="absolute inset-0 flex flex-col gap-1 overflow-y-auto scrollbar-fade"
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
                            <m.span
                              layoutId={motionProfile === "desktop" || motionProfile === "max" ? "sidebar-active-adv" : undefined}
                              transition={motionProfile === "max" ? { duration: 0.28, ease: "easeOut" } : { duration: 0.2, ease: "easeOut" }}
                              className="absolute inset-0 rounded-[11px] border border-[var(--inner-border)] bg-[var(--active-pill)] shadow-[0_2px_8px_rgba(0,0,0,0.06)]"
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
            </m.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-auto pt-4">
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
  ), [drawerOpen, sidebarPage, switchSidebarPage, motionProfile, appearanceQuery.data?.settings.runtime.sidebarIconDataUrl, localVersion, updateAvailable, releaseQuery.data?.html_url, latestTag, adminName, adminNameDraft, editingAdminName]);

  return (
    <>
      <CustomAtmosphere />
      <div className="relative z-10 mx-auto grid min-h-dvh max-w-[1560px] grid-cols-1 gap-4 p-4 lg:grid-cols-[272px_minmax(0,1fr)]">
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-60 cursor-default bg-black/30 backdrop-blur-[4px] lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      {sidebar}

      <div className={cn("flex min-h-0 min-w-0 flex-col gap-4", (pathKey === "/console-log" || pathKey === "/advanced/db-map") && "h-dvh overflow-hidden")}>
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
          <m.div key={location.pathname} {...routeTransition} className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
              <AnimatedOutlet />
          </m.div>
        </main>

        {/* Normal flow footer: `mt-auto` drops it to the bottom on short pages. */}
        {pathKey !== "/model-studio" && <div className={cn(isStudioComposerFocused && "hidden sm:block")}><FooterClock statusData={statusQuery.data} isError={statusQuery.isError} /></div>}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </>
  );
}
