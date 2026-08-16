
import type { JSX } from "solid-js";
import { For, Show, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { Bell, ChevronDown, Moon, Search, Sun, User } from "lucide-solid";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon";
import { cn } from "../../lib/cn";
import { focusRingClasses } from "../ui/styles";
import { theme, setTheme, userSession, logout } from "../../lib/store";

export interface HeaderNotification {
  id: string;
  title: string;
  detail?: string;
  timestamp?: string;
  severity?: "info" | "warning" | "danger";
}

export interface HeaderUser {
  name?: string;
  email?: string;
}

export interface HeaderProps {
  title?: string;
  notifications?: readonly HeaderNotification[];
  user?: HeaderUser;
  onSearch?: (query: string) => void;
  onNotificationSelect?: (notification: HeaderNotification) => void;
  onSignOut?: () => void;
  className?: string;
}

const routeTitles: Record<string, string> = {
  "/overview": "Overview",
  "/usage": "Usage",
  "/providers": "Providers",
  "/quota": "Quota",
  "/logs": "Console log",
  "/settings": "Settings",
};

const titleFromPath = (path: string): string => {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (routeTitles[normalized]) return routeTitles[normalized];
  if (normalized.startsWith("/share/")) return "Share";
  return "Dashboard";
};

const severityTone: Record<NonNullable<HeaderNotification["severity"]>, "info" | "warning" | "danger"> = {
  info: "info",
  warning: "warning",
  danger: "danger",
};

/**
 * Header — global app bar with theme toggle, notifications, and user menu.
 *
 * Integrates with the shared signals store: theme, sidebar collapsed, and
 * user session. Outside-click closes the popovers. Plays a 200ms fade-in
 * entrance animation on first mount via `.component-fade-in`.
 */
export function Header(props: HeaderProps): JSX.Element {
  const location = useLocation();
  const [search, setSearch] = createSignal("");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [notifOpen, setNotifOpen] = createSignal(false);

  const title = (): string => props.title ?? titleFromPath(location.pathname);
  const unreadCount = (): number => props.notifications?.length ?? 0;

  const user = (): HeaderUser => {
    if (props.user) return props.user;
    const session = userSession();
    if (session.user && typeof session.user === "object") {
      const candidate = session.user as Record<string, unknown>;
      const name = typeof candidate.name === "string" ? candidate.name : undefined;
      const email = typeof candidate.email === "string" ? candidate.email : undefined;
      return { name, email };
    }
    return {};
  };

  const toggleTheme = (): void => {
    const current = theme();
    const next: typeof current = current === "dark" ? "light" : "dark";
    setTheme(next);
  };

  const submitSearch = (event: Event): void => {
    event.preventDefault();
    const value = search().trim();
    if (!value) return;
    props.onSearch?.(value);
  };

  const handleSignOut = (): void => {
    setMenuOpen(false);
    logout();
    props.onSignOut?.();
  };

  onMount(() => {
    const outsideClick = (event: MouseEvent): void => {
      if (!menuOpen() && !notifOpen()) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      const root = document.getElementById("dashboard-header-root");
      if (root && !root.contains(target)) {
        setMenuOpen(false);
        setNotifOpen(false);
      }
    };
    document.addEventListener("click", outsideClick);
    onCleanup(() => document.removeEventListener("click", outsideClick));
  });

  const initials = createMemo((): string => {
    const value = user().name ?? user().email ?? "";
    const trimmed = value.trim();
    if (trimmed.length === 0) return "U";
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  });

  return (
    <header
      id="dashboard-header-root"
      role="banner"
      class={cn(
        "component-fade-in sticky top-4 z-30 flex items-center gap-2 rounded-[18px] border border-[var(--inner-border)] bg-[var(--glass-bg)] px-3 py-2.5 shadow-[var(--shadow-card)] sm:gap-3.5 sm:px-4 sm:py-3",
        props.className,
      )}
    >
      <div class="flex min-w-0 items-baseline gap-2">
        <h1 class="truncate text-[15px] font-bold tracking-tight text-[var(--text-1)] sm:text-[17px]">{title()}</h1>
        <span class="hidden text-xs text-[var(--text-3)] sm:inline" aria-hidden="true">/</span>
        <A href="/overview" class="hidden truncate text-xs text-[var(--text-3)] hover:text-[var(--text-2)] sm:inline">
          Cartethyia
        </A>
      </div>

      <form role="search" class="ml-auto hidden flex-1 max-w-sm items-center md:flex" onSubmit={submitSearch}>
        <label class="sr-only" for="dashboard-header-search">Search</label>
        <div class="relative flex w-full items-center">
          <Search size={14} class="pointer-events-none absolute left-2.5 text-[var(--text-3)]" aria-hidden="true" />
          <input
            id="dashboard-header-search"
            type="search"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search providers, sessions…"
            class={cn(
              "h-9 w-full rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] pl-8 pr-3 text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] outline-none transition-colors duration-150",
              "hover:bg-[var(--active-pill)] focus-visible:border-[var(--accent)] focus-visible:bg-[var(--glass-bg-2)]",
              focusRingClasses,
            )}
          />
        </div>
      </form>

      <div class="ml-auto flex shrink-0 items-center gap-1 md:ml-2">
        <IconButton
          icon={theme() === "dark" ? Sun : Moon}
          label={`Switch to ${theme() === "dark" ? "light" : "dark"} theme`}
          size="sm"
          variant="ghost"
          onClick={toggleTheme}
        />

        <div class="relative">
          <IconButton
            icon={Bell}
            label={unreadCount() > 0 ? `Notifications (${unreadCount()} unread)` : "Notifications"}
            size="sm"
            variant="ghost"
            onClick={() => {
              setNotifOpen((value) => !value);
              setMenuOpen(false);
            }}
          />
          <Show when={unreadCount() > 0}>
            <span class="pointer-events-none absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--status-danger)] px-1 text-[9px] font-bold text-white" aria-hidden="true">
              {unreadCount() > 99 ? "99+" : unreadCount()}
            </span>
          </Show>
          <Show when={notifOpen()}>
            <div
              role="dialog"
              aria-label="Notifications"
              class="component-slide-down absolute right-0 top-11 z-50 w-80 origin-top-right rounded-xl border border-[var(--inner-border)] bg-[var(--popover-bg)] p-1 shadow-2xl"
            >
              <Show
                when={(props.notifications?.length ?? 0) > 0}
                fallback={<div class="px-3 py-6 text-center text-xs text-[var(--text-3)]">No new notifications</div>}
              >
                <ul class="max-h-80 overflow-y-auto">
                  <For each={props.notifications}>
                    {(notification) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => {
                            props.onNotificationSelect?.(notification);
                            setNotifOpen(false);
                          }}
                          class="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-[var(--text-1)] transition-colors duration-150 hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]"
                        >
                          <Badge tone={severityTone[notification.severity ?? "info"]} class="mt-0.5 shrink-0">
                            {(notification.severity ?? "info").toUpperCase()}
                          </Badge>
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-[12px] font-semibold">{notification.title}</span>
                            <Show when={notification.detail}>
                              {(detail) => <span class="mt-0.5 block truncate text-[11px] text-[var(--text-2)]">{detail()}</span>}
                            </Show>
                          </span>
                          <Show when={notification.timestamp}>
                            {(timestamp) => <span class="shrink-0 text-[10px] text-[var(--text-3)]">{timestamp()}</span>}
                          </Show>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </Show>
        </div>

        <div class="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            aria-label="User menu"
            onClick={() => {
              setMenuOpen((value) => !value);
              setNotifOpen(false);
            }}
            class={cn(
              "inline-flex h-8 items-center gap-2 rounded-full border border-transparent bg-[var(--hover)] pl-1 pr-2 text-[11px] font-semibold text-[var(--text-1)] outline-none transition-colors duration-150 hover:bg-[var(--active-pill)] focus-visible:border-[var(--accent)]",
              focusRingClasses,
            )}
          >
            <span aria-hidden="true" class="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[10px] font-bold text-[var(--accent)]">
              {initials()}
            </span>
            <span class="hidden truncate max-w-[8rem] sm:inline">{user().name ?? user().email ?? "Account"}</span>
            <ChevronDown size={12} aria-hidden="true" class="text-[var(--text-3)]" />
          </button>
          <Show when={menuOpen()}>
            <div
              role="menu"
              aria-label="Account"
              class="component-slide-down absolute right-0 top-10 z-50 w-56 origin-top-right rounded-xl border border-[var(--inner-border)] bg-[var(--popover-bg)] p-1 shadow-2xl"
            >
              <div class="px-2.5 py-2">
                <div class="flex items-center gap-2">
                  <span aria-hidden="true" class="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[10px] font-bold text-[var(--accent)]">
                    {initials()}
                  </span>
                  <div class="min-w-0">
                    <div class="truncate text-[12px] font-semibold">{user().name ?? "Signed in"}</div>
                    <Show when={user().email}>
                      {(email) => <div class="truncate text-[10px] text-[var(--text-3)]">{email()}</div>}
                    </Show>
                  </div>
                </div>
              </div>
              <div class="my-1 h-px bg-[var(--inner-border)]" aria-hidden="true" />
              <Button
                variant="ghost"
                size="sm"
                class="w-full justify-start gap-2 px-2.5"
                onClick={handleSignOut}
              >
                <User size={14} aria-hidden="true" />
                Sign out
              </Button>
            </div>
          </Show>
        </div>
      </div>
    </header>
  );
}
