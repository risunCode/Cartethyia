import {
  Activity,
  Bell,
  Clock,
  Cpu,
  FlaskConical,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Network,
  Rocket,
  Link2,
  Search,
  ScrollText,
  Server,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Sun,
  Terminal,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { usePresence } from "../lib/use-presence";
import { useModalFocus } from "../lib/hooks/use-modal-focus";
import { applyConsoleTheme, isDarkEffective, readConsoleTheme, writeConsoleTheme } from "../lib/theme";
import { consoleRequest } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { usePullToRefresh } from "../lib/use-pull-to-refresh";
import { useSystemHealth } from "../lib/hooks/system";
import { Atmosphere } from "./Atmosphere";
import { DASHBOARD_RELEASE_LABEL } from "../lib/version";
import { providerDisplayName } from "../lib/provider-names";
import { useCustomizationAssetUrl, useCustomizationBranding } from "../lib/customization";
import type { SessionUser } from "../lib/contracts";
import { formatUptime } from "../lib/format";

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
      { label: "Share", path: "/share", icon: Link2 },
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
      { label: "Customization", path: "/customization", icon: Sparkles },
      { label: "Console Log", path: "/console-log", icon: ScrollText },
      { label: "Settings", path: "/settings", icon: SettingsIcon },
    ],
  },
];


const titlesMap: Record<string, { title: string; sub: string }> = {
  "/": { title: "Overview", sub: "Gateway health, capacity, and live metrics" },
  "/usage": { title: "Usage & Metrics", sub: "Token economics, requests, and cost breakdown" },
  "/providers": { title: "Provider Catalog", sub: "Upstream credentials, models, and latency" },
  "/combos": {
    title: "Combos & Routing",
    sub: "Failover policies, model aliases, and weighted routes",
  },
  "/quota": { title: "Quota Management", sub: "Rate limits, leases, and tenant quotas" },
  "/proxy": {
    title: "Proxy & Requests",
    sub: "Network pools, SOCKS5/HTTP egress, and dispatch",
  },
  "/customization": { title: "Customization", sub: "Theme appearance, ambient mesh, and branding" },
  "/model-lab": { title: "Model Lab", sub: "Live model playground — chat, thinking, and image generation" },
  "/cli-tools": {
    title: "CLI Tools",
    sub: "Claude Code CLI, OpenCode, and local developer tool integrations",
  },
  "/console-log": { title: "Console Log", sub: "Live server logs and audit trail" },
  "/share": { title: "Shared Access", sub: "Enrollment links and recipient activity" },
  "/settings": {
    title: "Settings",
    sub: "Account security, runtime preferences, and state recovery",
  },
};

const CONSOLE_FALLBACK = { title: "Console", sub: "Cartethyia AI Gateway Administration" };

/**
 * Resolves the topbar title/subtitle for a pathname.
 *
 * The two parameterized routes (`/providers/:providerId`, `/cli-tools/:toolId`)
 * carry their subject in the path, so a flat `titlesMap` lookup would drop them
 * onto the generic console fallback. They are matched by pattern instead.
 */
function resolveRouteMeta(pathname: string): { title: string; sub: string } {
  const providerMatch = /^\/providers\/([^/]+)\/?$/.exec(pathname);
  if (providerMatch?.[1]) {
    return {
      title: providerDisplayName(providerMatch[1]),
      sub: "Routing, accounts, models, and health",
    };
  }
  const toolMatch = /^\/cli-tools\/([^/]+)\/?$/.exec(pathname);
  if (toolMatch?.[1]) {
    return {
      title: "CLI Tool",
      sub: `${toolMatch[1]} — mappings, endpoints, and downloadable config`,
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

  // Stay in sync when the theme changes elsewhere (e.g. Customization page).
  useEffect(() => {
    const resync = () => setTheme(readConsoleTheme());
    window.addEventListener("console-customization-change", resync);
    window.addEventListener("storage", resync);
    return () => {
      window.removeEventListener("console-customization-change", resync);
      window.removeEventListener("storage", resync);
    };
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
      <span key={dark ? "sun" : "moon"} style={{ display: "grid", placeItems: "center" }}>
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
    <div style={{ position: "relative" }}>
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
              className="popout-enter glass"
              style={{
                position: "fixed",
                zIndex: 60,
                top: "64px",
                right: "16px",
                width: "min(340px, calc(100vw - 32px))",
                borderRadius: "20px",
                padding: "16px",
                boxShadow: "var(--shadow-popout)",
                border: "1px solid var(--inner-border)",
                background: "var(--popover-bg)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    fontWeight: 700,
                    fontSize: "14px",
                  }}
                >
                  <span
                    style={{
                      width: "26px",
                      height: "26px",
                      borderRadius: "999px",
                      background: "var(--accent-soft)",
                      color: "var(--accent)",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    <Bell size={13} />
                  </span>
                  <span>Notifications</span>
                </div>
                <button
                  type="button"
                  aria-label="Close notifications"
                  onClick={() => setOpen(false)}
                  style={{ fontSize: "12px", color: "var(--text-tertiary)", background: "transparent", border: "none", cursor: "pointer", padding: "4px" }}
                >
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div
                  style={{
                    padding: "12px",
                    borderRadius: "14px",
                    border: "1px solid var(--inner-border)",
                    background: "var(--surface-2)",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                  }}
                >
                  <div>
                    <p style={{ fontWeight: 600, fontSize: "12.5px" }}>
                      {isHealthy ? "All systems operational" : "Gateway degraded"}
                    </p>
                    <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                      {isHealthy ? "Postgres & Redis admission connected." : "Check connection logs."}
                    </p>
                  </div>
                </div>
                <div
                  style={{
                    padding: "12px",
                    borderRadius: "14px",
                    border: "1px solid var(--accent-soft)",
                    background: "var(--accent-soft)",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                  }}
                >
                  <Rocket
                    size={16}
                    style={{ color: "var(--accent)", marginTop: "2px", flexShrink: 0 }}
                  />
                  <div>
                    <p style={{ fontWeight: 600, fontSize: "12.5px", color: "var(--accent)" }}>
                      {DASHBOARD_RELEASE_LABEL}
                    </p>
                    <p style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
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
      className={`dialog-overlay${closing ? " closing" : ""}`}
      role="presentation"
      onMouseDown={close}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`dialog-panel card-solid${closing ? " closing" : ""}`}
        style={{
          width: "min(540px, calc(100vw - 32px))",
          borderRadius: "20px",
          overflow: "hidden",
          boxShadow: "var(--shadow-popout)",
          background: "var(--surface-1)",
          border: "1px solid var(--inner-border)",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "14px 18px",
            borderBottom: "1px solid var(--inner-border)",
          }}
        >
          <Search size={16} style={{ color: "var(--text-tertiary)" }} />
          <h2
            id="palette-title"
            style={{
              position: "absolute",
              width: "1px",
              height: "1px",
              padding: 0,
              margin: "-1px",
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
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
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: "14px",
              color: "var(--text-primary)",
            }}
          />
          <kbd
            style={{
              fontSize: "10px",
              padding: "2px 6px",
              borderRadius: "6px",
              background: "var(--hover)",
              border: "1px solid var(--inner-border)",
              color: "var(--text-tertiary)",
            }}
          >
            ESC
          </kbd>
        </div>
        <div
          ref={listRef}
          id="command-palette-listbox"
          role="listbox"
          aria-label="Pages"
          style={{ maxHeight: "320px", overflowY: "auto", padding: "8px" }}
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
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 14px",
                borderRadius: "10px",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--text-primary)",
                textAlign: "left",
                transition: "background-color var(--dur-micro) var(--ease-spring)",
                backgroundColor: index === clampedIndex ? "var(--hover)" : "transparent",
              }}
            >
              <item.icon size={16} style={{ color: "var(--text-secondary)" }} />
              <span style={{ flex: 1 }}>{item.label}</span>
              <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>↵</span>
            </button>
          ))}
          {filtered.length === 0 ? (
            <p
              style={{
                padding: "16px",
                textAlign: "center",
                fontSize: "12.5px",
                color: "var(--text-tertiary)",
              }}
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
}: {
  group: NavGroupDef;
  pathname: string;
}): ReactNode {
  return (
    <div className="nav-group-section">
      <p className="nav-group-title">{group.label}</p>
      <SidebarNavList items={group.items} pathname={pathname} />
    </div>
  );
}

function SidebarNavList({ items, pathname }: { items: readonly NavItemDef[]; pathname: string }) {
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

function FooterClock() {
  const healthQuery = useSafeSystemHealth();
  const [now, setNow] = useState(() => new Date());
  const location = useLocation();

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const isHealthy = healthQuery.data?.status === "healthy";
  const isError = healthQuery.isError;
  const uptimeSeconds = healthQuery.data?.uptime_seconds;
  // Immersive pages (Model Lab) hide the ops status pill — a chatbot
  // surface should not narrate gateway health at the user.
  const hideStatus = location.pathname === "/model-lab";

  const fmt = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "UTC", hour12: false });
  const fmtLocal = (d: Date) => d.toLocaleTimeString("en-GB", { hour12: false });

  return (
    <footer className="glass app-footer">
      {/* Row 1 Left (atas1): Status — hidden on immersive pages */}
      {!hideStatus ? (
        <div className="footer-status-pill">
          <span>
            {isError
              ? "System offline"
              : isHealthy
                ? "All systems operational"
                : "Connecting to gateway…"}
          </span>
        </div>
      ) : null}

      {/* Row 1 Right (kanan3): UTC Time */}
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" }}
        title="UTC time"
      >
        <Globe size={13} style={{ color: "var(--text-tertiary)" }} />
        <span>{fmt(now)} UTC</span>
      </div>

      {/* Row 2 Left (atas2): System local time */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }} title="Server system time">
        <Clock size={13} style={{ color: "var(--text-tertiary)" }} />
        <span>{fmtLocal(now)} system</span>
      </div>

      {/* Row 2 Right (kanan4): Uptime */}
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" }}
        title="Gateway Uptime"
      >
        <Timer size={13} style={{ color: "var(--text-tertiary)" }} />
        <span>uptime {formatUptime(uptimeSeconds)}</span>
      </div>
    </footer>
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
  const healthQuery = useSafeSystemHealth();
  const drawerPresence = usePresence(drawerOpen);
  const pull = usePullToRefresh(() => queryClient.invalidateQueries());

  const isHealthy = healthQuery.data?.status === "healthy";

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

  const meta = resolveRouteMeta(location.pathname);
  const [branding] = useCustomizationBranding();
  const customBrandingUrl = useCustomizationAssetUrl(branding.asset);
  const defaultLogoUrl = `${import.meta.env.BASE_URL}favicon_love.webp`;
  const logoUrl = customBrandingUrl ?? defaultLogoUrl;
  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <Atmosphere />
      <div className="app-shell-root">
        {drawerPresence.mounted && (
          <button
            type="button"
            aria-label="Close navigation"
            className={`mobile-scrim${drawerPresence.closing ? " closing" : ""}`}
            onClick={() => setDrawerOpen(false)}
          />
        )}

        {/* Sidebar Rail */}
        <aside
          className={`glass app-sidebar ${drawerOpen ? "is-open" : ""}`}
          aria-label="Dashboard navigation"
        >
          <div className="brand-header">
            <div className="brand-icon" aria-hidden="true" style={{ overflow: "hidden", padding: 0 }}>
              <img
                src={logoUrl}
                alt="Cartethyia"
                onError={(event) => {
                  event.currentTarget.onerror = null;
                  event.currentTarget.src = defaultLogoUrl;
                }}
                style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              />
            </div>
            <div className="brand-meta">
              <div className="brand-name">
                <span>Cartethyia</span>
              </div>
              <div className="brand-version-badge">
                <span>{DASHBOARD_RELEASE_LABEL}</span>
              </div>
            </div>
          </div>

          <nav style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {navigationGroups.map((group) => (
              <SidebarNavGroup key={group.label} group={group} pathname={location.pathname} />
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
                onClick={() => void logout()}
                disabled={loggingOut}
                aria-label="Sign out"
                title="Sign out"
                className="topbar-icon-button"
                style={{ width: "30px", height: "30px", borderRadius: "8px" }}
              >
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>

        {/* Main Column */}
        <div className="app-main-column" ref={pull.scrollerRef as React.RefObject<HTMLDivElement>}>
          <div
            aria-hidden={pull.pullPx === 0 && !pull.refreshing}
            style={{
              height: `${pull.refreshing ? 44 : pull.pullPx}px`,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "12px",
              color: "var(--text-tertiary)",
              transition: pull.pullPx === 0 && !pull.refreshing ? "height 180ms ease" : undefined,
            }}
          >
            {pull.refreshing ? "Refreshing…" : pull.pullPx > 0 ? "Pull to refresh" : ""}
          </div>
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
              <h1 className="topbar-title">{meta.title}</h1>
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
                  style={{
                    fontSize: "10px",
                    padding: "1px 5px",
                    borderRadius: "4px",
                    background: "var(--surface-1)",
                    border: "1px solid var(--inner-border)",
                  }}
                >
                  ⌘K
                </kbd>
              </button>
              <ThemeToggle />
              <NotificationsPopover isHealthy={Boolean(isHealthy)} />
            </div>
          </header>

          {/* Content Outlet */}
          <main
            className="route-enter"
            style={{
              flex: "1 0 auto",
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            {children}
          </main>

          {/* Footer Taskbar Clock — hidden on immersive pages */}
          {location.pathname !== "/model-lab" ? (
            <div
              style={{ marginTop: "auto", paddingTop: "12px", paddingBottom: "8px", width: "100%" }}
            >
              <FooterClock />
            </div>
          ) : null}
        </div>
      </div>
      <CommandPalette open={paletteOpen} close={() => setPaletteOpen(false)} />
    </>
  );
}
