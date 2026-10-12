import {
  Activity,
  Bell,
  Clock,
  Cpu,
  FlaskConical,
  Globe,
  LayoutDashboard,
  LogOut,
  MemoryStick,
  Menu,
  Monitor,
  Moon,
  Network,
  Rocket,
  Server,
  Settings as SettingsIcon,
  ShieldAlert,
  ScrollText,
  Sun,
  Terminal,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import { Palette } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { applyConsoleTheme, isDarkEffective, readConsoleTheme, writeConsoleTheme } from "../../lib/theme";
import { BackgroundLayer } from "../../features/customization/BackgroundLayer";
import { applyCustomization, readCustomizationSettings } from "../../features/customization/settings";
import { consoleRequest } from "../../data/api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { queryClient } from "../../data/query-client";
import { prefetchRouteIntent } from "../../data/route-prefetch";
import { useSystemHealth, useLatestRelease } from "../../hooks/system";
import { useProviders } from "../../hooks/providers";
import { DASHBOARD_RELEASE_LABEL, DASHBOARD_VERSION } from "../../lib/version";
import { GITHUB_RELEASES_URL, GITHUB_REPO_URL } from "../../lib/links";
import { isNewerRelease, type SystemHealthResponse } from "../../data/contracts";
import type { SessionUser } from "../../data/contracts";

interface NavItemDef {
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon;
  readonly badge?: string;
}

interface NavGroupDef {
  readonly label: string;
  readonly items: readonly NavItemDef[];
}

export const navigationGroups: readonly NavGroupDef[] = [
  {
    label: "Main",
    items: [
      { label: "Overview", path: "/", icon: LayoutDashboard },
      { label: "Usage", path: "/usage", icon: Activity },
      { label: "Providers", path: "/providers", icon: Server },
      { label: "Model Lab", path: "/model-lab", icon: FlaskConical },
    ],
  },
  {
    label: "Control",
    items: [
      { label: "Combos & Routes", path: "/combos", icon: Cpu },
      { label: "Quota Management", path: "/quota", icon: ShieldAlert },
      { label: "Proxy & Requests", path: "/proxy", icon: Network },
      { label: "CLI Tools", path: "/cli-tools", icon: Terminal },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Customization", path: "/customization", icon: Palette },
      { label: "Console Log", path: "/console-log", icon: ScrollText },
      { label: "Settings", path: "/settings", icon: SettingsIcon },
    ],
  },
];


const titlesMap: Record<string, { title: string; sub: string; icon: LucideIcon }> = {
  "/": { title: "Overview", sub: "Gateway health, capacity, and live metrics" , icon: LayoutDashboard },
  "/usage": { title: "Usage & Metrics", sub: "Token economics, requests, and cost breakdown" , icon: Activity },
  "/providers": { title: "Provider Catalog", sub: "Upstream credentials, models, and latency" , icon: Server },
  "/combos": {
    title: "Combos & Routing",
    sub: "Failover policies, model aliases, and weighted routes",
    icon: Cpu,
  },
  "/quota": { title: "Quota Management", sub: "Rate limits, leases, and tenant quotas" , icon: ShieldAlert },
  "/proxy": {
    title: "Proxy & Requests",
    sub: "Network pools, SOCKS5/HTTP egress, and dispatch",
    icon: Network,
  },
  "/customization": { title: "Customization", sub: "Background, transparency, and blur", icon: Palette },
  "/model-lab": { title: "Model Lab", sub: "Chat a routed model without leaving the console", icon: FlaskConical },
  "/console-log": { title: "Console Log", sub: "Live server logs and audit trail" , icon: ScrollText },
  "/cli-tools": {
    title: "CLI Tools",
    sub: "Claude Code CLI, OpenCode, and local developer tool integrations",
    icon: Terminal,
  },
  "/settings": {
    title: "Settings",
    sub: "Account security, runtime preferences, and state recovery",
    icon: SettingsIcon,
  },
};

const CONSOLE_FALLBACK = { title: "Console", sub: "Cartethyia AI Gateway Administration", icon: LayoutDashboard };

/**
 * Resolves the topbar title/subtitle for a pathname.
 *
 * The two parameterized routes (`/providers/:providerId`, `/cli-tools/:toolId`)
 * carry their subject in the path, so a flat `titlesMap` lookup would drop them
 * onto the generic console fallback. They are matched by pattern instead.
 */
function resolveRouteMeta(
  pathname: string,
  providers: readonly { readonly providerId: string; readonly displayName: string; readonly label?: string }[],
): { title: string; sub: string; icon: LucideIcon } {
  const providerMatch = /^\/providers\/([^/]+)\/?$/.exec(pathname);
  if (providerMatch?.[1]) {
    const provider = providers.find((candidate) => candidate.providerId === providerMatch[1]);
    return {
      title: provider?.label || provider?.displayName || providerMatch[1],
      sub: "Routing, accounts, models, and health",
      icon: Server,
    };
  }
  const toolMatch = /^\/cli-tools\/([^/]+)\/?$/.exec(pathname);
  if (toolMatch?.[1]) {
    return {
      title: "CLI Tool",
      sub: `${toolMatch[1]} — mappings, endpoints, and downloadable config`,
      icon: Terminal,
    };
  }
  return titlesMap[pathname] ?? CONSOLE_FALLBACK;
}

function useSafeSystemHealth() {
  try {
    return useSystemHealth();
  } catch {
    return { data: undefined, isError: false, isFetching: false, isPending: false };
  }
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => readConsoleTheme());
  const dark = isDarkEffective(theme);

  // Stay in sync with theme changes from another tab.
  useEffect(() => {
    const resync = () => setTheme(readConsoleTheme());
    window.addEventListener("storage", resync);
    return () => window.removeEventListener("storage", resync);
  }, []);

  useEffect(() => {
    applyConsoleTheme(theme);
  }, [theme]);

  return (
    <button
      type="button"
      onClick={() => {
        const next = dark ? "light" : "dark";
        setTheme(next);
        writeConsoleTheme(next);
      }}
      aria-label="Toggle theme"
      aria-pressed={dark}
      className="topbar-icon-button"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span key={dark ? "sun" : "moon"} className="grid place-items-center">
        {dark ? <Sun size={17} /> : <Moon size={17} />}
      </span>
    </button>
  );
}

const LOCAL_CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const UTC_CLOCK_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  const totalSeconds = Math.floor(seconds);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  return `${totalMinutes}m`;
}

function formatProcessRss(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const unit = bytes >= 1024 ** 3
    ? { divisor: 1024 ** 3, label: "GiB" }
    : { divisor: 1024 ** 2, label: "MiB" };
  return `${(bytes / unit.divisor).toFixed(1)} ${unit.label}`;
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  title,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-control border border-inner-border bg-surface-2 p-3" title={title}>
      <dt className="flex items-center gap-2 text-micro font-medium text-text-tertiary">
        <Icon size={13} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </dt>
      <dd className="mt-1 truncate font-mono text-caption font-semibold tabular-nums text-text-primary">
        {value}
      </dd>
      {detail ? <dd className="mt-1 text-micro text-text-secondary">{detail}</dd> : null}
    </div>
  );
}

function NotificationsPopover({ health }: { health?: SystemHealthResponse }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        contentRef.current &&
        !contentRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const healthTitle = !health
    ? "System health unavailable"
    : health.status === "healthy"
      ? "All systems operational"
      : health.status === "degraded"
        ? "Gateway degraded"
        : "Gateway unhealthy";
  const healthDescription = !health
    ? "Live gateway metrics are not available."
    : health.status === "healthy"
      ? "Postgres & Redis admission connected."
      : health.status === "degraded"
        ? "Check connection logs."
        : "Gateway is reporting an unhealthy status.";
  const memoryDetail = health
    ? [
        Number.isFinite(health.memory_percent)
          ? `${health.memory_percent.toFixed(1)}% of system RAM`
          : undefined,
        health.database_in_process ? "In-process DB included" : undefined,
      ].filter(Boolean).join(" · ") || undefined
    : undefined;
  const cpuDetail = health
    ? Number.isFinite(health.cpu_cores) && health.cpu_cores > 0
      ? `1-min load · ${health.cpu_cores} cores`
      : "Normalized 1-min load"
    : undefined;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="topbar-icon-button"
        aria-label="Notifications"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={17} />
      </button>
      {open
        ? createPortal(
            <div
              ref={contentRef}
              role="dialog"
              aria-label="Notifications"
              className="app-topbar-popover popout-enter glass rounded-sidebar border border-inner-border bg-popover-bg p-5 shadow-popout z-popover"
            >
              <div
                className="mb-3 flex shrink-0 items-center justify-between"
              >
                <div
                  className="flex items-center gap-3 font-bold text-body-lg"
                >
                  <span
                    className="w-13 h-13 rounded-pill bg-accent-soft text-accent grid place-items-center"
                  >
                    <Bell size={13} />
                  </span>
                  <span>Notifications</span>
                </div>
                <button
                  type="button"
                  aria-label="Close notifications"
                  onClick={() => setOpen(false)}
                  className="cursor-pointer border-none bg-transparent p-2 text-caption text-text-tertiary"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="scroll-region min-h-0 flex-1 flex flex-col gap-3">
                <div className="flex items-start gap-3 rounded-card border border-inner-border bg-surface-2 p-4">
                  <span className="mt-0.5 grid w-12 h-12 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
                    <Server size={16} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-caption">{healthTitle}</p>
                    <p className="text-badge text-text-secondary mt-1">{healthDescription}</p>
                  </div>
                </div>
                <dl aria-label="Runtime metrics" className="grid grid-cols-2 gap-2">
                  <MetricTile icon={Clock} label="Local time" value={LOCAL_CLOCK_FORMATTER.format(now)} />
                  <MetricTile icon={Globe} label="UTC" value={UTC_CLOCK_FORMATTER.format(now)} />
                  <MetricTile
                    icon={Timer}
                    label="Uptime"
                    value={health ? formatUptime(health.uptime_seconds) : "Unavailable"}
                    detail={health && Number.isFinite(health.uptime_seconds) && health.uptime_seconds >= 0
                      ? "Gateway process running"
                      : undefined}
                  />
                  <MetricTile
                    icon={MemoryStick}
                    label="Process RSS"
                    value={health ? formatProcessRss(health.memory_bytes) : "Unavailable"}
                    detail={memoryDetail}
                    title="Process resident set size; percentage is share of system RAM."
                  />
                  <MetricTile
                    icon={Cpu}
                    label="CPU load"
                    value={health && Number.isFinite(health.cpu_percent)
                      ? `${health.cpu_percent.toFixed(1)}%`
                      : "Unavailable"}
                    detail={cpuDetail}
                    title="One-minute load average normalized by the number of CPU cores."
                  />
                  <MetricTile
                    icon={Monitor}
                    label="Runtime"
                    value={health?.platform?.trim() || "Unavailable"}
                    detail={health?.platform?.trim() ? "Gateway host platform" : undefined}
                    title={health?.platform?.trim() || "Runtime platform unavailable"}
                  />
                </dl>
                <div className="flex items-start gap-3 rounded-card border border-inner-border bg-surface-2 p-4">
                  <span className="mt-0.5 grid w-12 h-12 shrink-0 place-items-center rounded-control bg-surface-1 text-text-secondary">
                    <Rocket size={16} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-caption">{DASHBOARD_RELEASE_LABEL}</p>
                    <p className="text-badge text-text-secondary mt-1">
                      High-performance AI Gateway & Protocol Orchestrator.
                    </p>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}


function SidebarNavGroup({
  group,
  pathname,
  onIntent,
}: {
  readonly group: NavGroupDef;
  readonly pathname: string;
  readonly onIntent: (path: string) => void;
}): ReactNode {
  return (
    <div className="nav-group-section">
      <p className="nav-group-title">{group.label}</p>
      <SidebarNavList items={group.items} pathname={pathname} onIntent={onIntent} />
    </div>
  );
}

function SidebarNavList({
  items,
  pathname,
  onIntent,
}: {
  readonly items: readonly NavItemDef[];
  readonly pathname: string;
  readonly onIntent: (path: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ top: 0, height: 0, opacity: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const active = container.querySelector('[data-active="true"]') as HTMLElement | null;
    if (!active) {
      setIndicator((s) => ({ ...s, opacity: 0 }));
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    setIndicator({
      top: activeRect.top - containerRect.top,
      height: activeRect.height,
      opacity: 1,
    });
  }, [pathname, items]);

  return (
    <div ref={containerRef} className="nav-items-container">
      <div
        className="sidebar-active-indicator"
        style={{
          transform: `translateY(${indicator.top}px)`,
          height: `${indicator.height}px`,
          opacity: indicator.opacity,
        }}
        aria-hidden="true"
      />
      {items.map((item) => {
        const isActive =
          item.path === "/"
            ? pathname === "/"
            : pathname === item.path || pathname.startsWith(`${item.path}/`);
        return (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            data-active={isActive ? "true" : undefined}
            className={`nav-link-item ${isActive ? "active" : ""}`}
            onMouseEnter={() => onIntent(item.path)}
            onFocus={() => onIntent(item.path)}
          >
            <item.icon size={17} className="nav-link-icon" />
            <span>{item.label}</span>
            {item.badge ? <span className="nav-link-badge">{item.badge}</span> : null}
          </NavLink>
        );
      })}
    </div>
  );
}

export function DashboardShell({
  user,
  children,
}: {
  readonly user: SessionUser;
  readonly children: ReactNode;
}): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const healthQuery = useSafeSystemHealth();
  const releaseQuery = useLatestRelease();
  // The running version is the gateway's, not the bundled dashboard's: the
  // badge answers "is the install behind", and the install is what an operator
  // upgrades. Falls back to the dashboard label so the badge still reads.
  const localVersion = healthQuery.data?.version ?? DASHBOARD_VERSION;
  const latestTag = releaseQuery.data?.tag_name?.replace(/^v/, "");
  const updateAvailable = isNewerRelease(localVersion, latestTag);
  const providersQuery = useProviders();

  const prefetchIntent = (path: string): void => {
    void prefetchRouteIntent(queryClient, path);
  };

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // The shell stays mounted across navigations, so the document keeps the
  // previous page's offset and the next page opens already scrolled. Layout
  // timing, not `useEffect`: a post-paint reset shows the stale offset for one
  // frame.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  const logout = async () => {
    setLoggingOut(true);
    try {
      await consoleRequest<void>("/auth/logout", { method: "POST" });
    } finally {
      // Drop every cached tenant view before leaving so the next login
      // never renders the previous tenant's data.
      queryClient.clear();
      navigate("/login", { replace: true });
    }
  };

  useEffect(() => {
    document.documentElement.dataset.glassEnabled = "true";
    applyCustomization(readCustomizationSettings());
    return () => {
      delete document.documentElement.dataset.glassEnabled;
    };
  }, []);

  const meta = resolveRouteMeta(location.pathname, providersQuery.data ?? []);
  const defaultLogoUrl = `${import.meta.env.BASE_URL}assets/brand/sidebar_ico.jpg`;
  const logoUrl = defaultLogoUrl;
  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app-shell-frame">
      <div className="app-shell-root" data-drawer={drawerOpen ? "open" : undefined} onClick={(event) => { if (drawerOpen && (event.target as HTMLElement).closest(".app-main-column")) setDrawerOpen(false); }}>

        <aside
          className={`glass app-sidebar ${drawerOpen ? "is-open" : ""}`}
          aria-label="Dashboard navigation"
        >
          <div className="brand-header">
            <div aria-hidden="true" className="brand-icon overflow-hidden p-0">
              <img
                src={logoUrl}
                alt="Cartethyia"
                onError={(event) => {
                  event.currentTarget.onerror = null;
                  event.currentTarget.src = defaultLogoUrl;
                }}
                className="w-full h-full object-cover block"
              />
            </div>
            <div className="brand-meta">
              <div className="brand-name">
                <span>Cartethyia</span>
              </div>
              <div className="brand-version-badge">
                <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="brand-version-link">{DASHBOARD_RELEASE_LABEL}</a>
                {updateAvailable ? (
                  <a
                    href={releaseQuery.data?.html_url ?? GITHUB_RELEASES_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="brand-update-badge"
                    title={
                      latestTag === undefined
                        ? "A newer Cartethyia release is available on GitHub"
                        : `Update available on GitHub: v${latestTag}`
                    }
                  >
                    <Rocket size={9} className="shrink-0" aria-hidden="true" />
                    update
                  </a>
                ) : null}
              </div>
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto py-2 px-0">
            {navigationGroups.map((group) => (
              <SidebarNavGroup
                key={group.label}
                group={group}
                pathname={location.pathname}
                onIntent={prefetchIntent}
              />
            ))}
          </nav>

          {/* User Card */}
          <div className="sidebar-user-card">
            <div className="user-card-content">
              <div className="user-avatar" aria-hidden="true">
                {(user.displayName ?? user.email).slice(0, 2).toUpperCase()}
              </div>
              <div className="user-info">
                <p className="user-name">{user.displayName || "Admin"}</p>
                <p className="user-role">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={() => setLogoutOpen(true)}
                disabled={loggingOut}
                aria-label="Sign out"
                title="Sign out"
                className="topbar-icon-button w-15 h-15 rounded-inset"
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        {/* Main Column */}
        <div className="app-main-column">
          <BackgroundLayer />
          {/* Topbar Header */}
          <header className="glass app-topbar">
            <button
              type="button"
              aria-label="Open navigation"
              className="topbar-menu-btn"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu size={18} />
            </button>
            <div className="topbar-meta">
              <h1 className="topbar-title">
                <meta.icon className="topbar-title-icon" size={16} aria-hidden="true" />
                {meta.title}
              </h1>
              <p className="topbar-subtitle">{meta.sub}</p>
            </div>

            <div className="topbar-actions">
              <ThemeToggle />
              <NotificationsPopover health={healthQuery.data} />
            </div>
          </header>

          {/* Content Outlet */}
          <main className="route-enter w-full min-w-0">
            {children}
          </main>

        </div>
      </div>
      </div>
      <ConfirmDialog
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        onConfirm={logout}
        title="Sign out?"
        message="You will need to sign in again to open the console."
        confirmLabel="Sign out"
        danger
      />
    </>
  );
}
