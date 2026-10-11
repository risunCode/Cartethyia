import {
  Activity,
  Bell,
  Cpu,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  Rocket,
  Search,
  Server,
  Settings as SettingsIcon,
  ShieldAlert,
  ScrollText,
  Sun,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { Palette } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { usePresence } from "../../hooks/use-presence";
import { useModalFocus } from "../../hooks/use-modal-focus";
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
import { isNewerRelease } from "../../data/contracts";
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

/** Width cap for the floating panels that widen with the user's own pixel value
 *  and never exceed the viewport: a bare `width` utility would have to carry the
 *  `min()` through an arbitrary value. */
const VIEWPORT_CAPPED_WIDTH = { width: "min(340px, calc(100vw - 32px))" } as const;

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

function NotificationsPopover({ isHealthy }: { isHealthy: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

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
              className="popout-enter glass rounded-sidebar border border-inner-border bg-popover-bg p-8 shadow-popout fixed top-32 right-8 z-popover"
              style={{ ...VIEWPORT_CAPPED_WIDTH }}
            >
              <div
                className="flex items-center justify-between mb-6"
              >
                <div
                  className="flex items-center gap-4 font-bold text-body-lg"
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
              <div className="flex flex-col gap-5">
                <div
                  className="flex items-start gap-5 rounded-card border border-inner-border bg-surface-2 p-6"
                >
                  <div>
                    <p className="font-semibold text-caption">
                      {isHealthy ? "All systems operational" : "Gateway degraded"}
                    </p>
                    <p className="text-badge text-text-secondary mt-1">
                      {isHealthy ? "Postgres & Redis admission connected." : "Check connection logs."}
                    </p>
                  </div>
                </div>
                <div
                  className="p-6 rounded-card border border-accent-soft bg-accent-soft flex items-start gap-5"
                >
                  <Rocket
                    size={16}
                    className="text-accent mt-1 shrink-0"
                  />
                  <div>
                    <p className="font-semibold text-caption text-accent">
                      {DASHBOARD_RELEASE_LABEL}
                    </p>
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

function CommandPalette({ open, close }: { readonly open: boolean; readonly close: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo(() => navigationGroups.flatMap((group) => group.items), []);
  const filtered = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

  const { mounted, closing } = usePresence(open);
  // Shared modal focus contract: initial focus, Tab containment, opener
  // restore, and Escape handling.
  useModalFocus({ open, mounted, panelRef, onClose: close });

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the highlighted option scrolled into view during keyboard travel.
  useEffect(() => {
    if (!mounted) return;
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, mounted]);

  if (!mounted) return null;

  const clampedIndex =
    filtered.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), filtered.length - 1);

  const activate = (index: number) => {
    const item = filtered[index];
    if (!item) return;
    navigate(item.path);
    close();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(filtered.length === 0 ? 0 : (clampedIndex + 1) % filtered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        filtered.length === 0 ? 0 : (clampedIndex - 1 + filtered.length) % filtered.length,
      );
    } else if (event.key === "Enter") {
      activate(clampedIndex);
    }
  };
  return createPortal(
    <div
      className={`dialog-overlay fixed inset-0 z-drawer box-border flex items-center justify-center overflow-y-auto bg-overlay p-8 backdrop-blur-dialog max-small:p-6${closing ? " closing" : ""}`}
      role="presentation"
      onMouseDown={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`dialog-panel m-auto box-border flex max-h-[calc(100dvh-var(--spacing)*24)] flex-col overflow-hidden rounded-sidebar border border-border-strong bg-surface-1 shadow-window max-small:max-h-[calc(100dvh-var(--spacing)*12)]${closing ? " closing" : ""}`}
        style={VIEWPORT_CAPPED_WIDTH}
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-5 border-b border-inner-border py-7 px-9"
        >
          <Search size={16} className="text-text-tertiary" />
          <h2
            id="palette-title"
            className="sr-only"
          >
            Command palette
          </h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Go to page… (e.g. Providers, Quota)"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="command-palette-listbox"
            aria-activedescendant={
              filtered.length === 0 ? undefined : `command-palette-option-${clampedIndex}`
            }
            className="flex-1 border-none bg-transparent text-body-lg text-text-primary outline-none"
          />
          <kbd
            className="rounded-chip border border-inner-border bg-hover py-1 px-3 text-micro text-text-tertiary"
          >
            ESC
          </kbd>
        </div>
        <div
          ref={listRef}
          id="command-palette-listbox"
          role="listbox"
          aria-label="Pages"
          className="max-h-160 overflow-y-auto p-4"
        >
          {filtered.map((item, index) => (
            <button
              key={item.path}
              id={`command-palette-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === clampedIndex}
              tabIndex={-1}
              onClick={() => activate(index)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`w-full cursor-pointer items-center rounded-control bg-transparent px-7 py-5 text-left font-medium text-body text-text-primary transition-colors duration-(--dur-micro) ease-spring ${index === clampedIndex ? "bg-hover" : ""}`}
            >
              <item.icon size={16} className="text-text-secondary" />
              <span className="flex-1">{item.label}</span>
              <span className="text-badge text-text-tertiary">↵</span>
            </button>
          ))}
          {filtered.length === 0 ? (
            <p
              className="p-8 text-center text-caption text-text-tertiary"
            >
              No matching pages found.
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
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
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  const isHealthy = healthQuery.data?.status === "healthy";
  const prefetchIntent = (path: string): void => {
    void prefetchRouteIntent(queryClient, path);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="topbar-button"
                aria-label="Command palette"
              >
                <Search size={14} />
                <span>Command palette</span>
                <kbd
                  className="rounded-tiny border border-inner-border bg-surface-1 px-2.5 py-0.5 text-micro"
                >
                  ⌘K
                </kbd>
              </button>
              <ThemeToggle />
              <NotificationsPopover isHealthy={Boolean(isHealthy)} />
            </div>
          </header>

          {/* Content Outlet */}
          <main className="route-enter w-full min-w-0">
            {children}
          </main>

        </div>
      </div>
      </div>
      <CommandPalette open={paletteOpen} close={() => setPaletteOpen(false)} />
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
