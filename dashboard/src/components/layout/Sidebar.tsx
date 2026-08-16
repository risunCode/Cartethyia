
import type { JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import { A, useLocation } from "@solidjs/router";
import type { LucideIcon } from "lucide-solid";
import {
  Activity,
  Gauge,
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Share2,
  TerminalSquare,
  Users,
} from "lucide-solid";
import { IconButton } from "../ui/icon";
import { StatusIndicator } from "../ui/icon";
import { cn } from "../../lib/cn";
import { sidebarCollapsed, setSidebarCollapsed, theme, setTheme } from "../../lib/store";
import { focusRingClasses } from "../ui/styles";

export interface SidebarNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  status?: "ok" | "warn" | "error" | "offline";
}

export interface SidebarNavSection {
  title?: string;
  items: readonly SidebarNavItem[];
}

export interface SidebarProps {
  sections?: readonly SidebarNavSection[];
  footer?: JSX.Element;
  className?: string;
}

const DEFAULT_SECTIONS: readonly SidebarNavSection[] = [
  {
    items: [
      { href: "/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/usage", label: "Usage", icon: Activity },
      { href: "/providers", label: "Providers", icon: Users },
      { href: "/quota", label: "Quota", icon: Gauge },
      { href: "/console", label: "Console log", icon: TerminalSquare },
      { href: "/share", label: "Share", icon: Share2 },
    ],
  },
  {
    title: "Settings",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

const indicatorStatus = (s: SidebarNavItem["status"]): "ok" | "warn" | "error" | "offline" => s ?? "offline";

/**
 * Sidebar — primary left-hand navigation for the dashboard.
 *
 * Reads collapsed state and theme from the signals store; collapses to icon
 * rail via the `data-collapsed` attribute (caller's CSS). Plays a 200ms
 * fade-up entrance animation on first mount via `.component-fade-in`.
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const location = useLocation();
  const sections = (): readonly SidebarNavSection[] => props.sections ?? DEFAULT_SECTIONS;

  const isActive = (href: string): boolean => {
    const path = location.pathname;
    const exact = ["/overview", "/usage", "/providers", "/quota", "/console", "/settings"];
    if (exact.includes(href)) return path === href || path.startsWith(`${href}/`);
    return path === href;
  };

  const collapsed = (): boolean => sidebarCollapsed();
  const widthClass = createMemo(() => (collapsed() ? "w-[68px]" : "w-60"));

  const toggleCollapsed = (): void => {
    setSidebarCollapsed((value) => !value);
  };
  const toggleTheme = (): void => {
    const current = theme();
    const next: typeof current = current === "dark" ? "light" : "dark";
    setTheme(next);
  };

  return (
    <aside
      aria-label="Dashboard navigation"
      class={cn(
        "component-fade-in sticky top-0 z-30 hidden h-screen shrink-0 flex-col border-r border-[var(--inner-border)] bg-[var(--glass-bg)] backdrop-blur-md lg:flex",
        "transition-[width] duration-150 ease-out",
        widthClass(),
        props.className,
      )}
      data-collapsed={collapsed() ? "true" : "false"}
    >
      <div class="flex h-14 items-center justify-between gap-2 px-3">
        <Show
          when={!collapsed()}
          fallback={<span aria-hidden="true" class="mx-auto h-7 w-7 rounded-md bg-[var(--accent-soft)]" />}
        >
          <A href="/overview" class="flex min-w-0 items-center gap-2 outline-none" aria-label="Cartethyia dashboard home">
            <span class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--accent)] text-xs font-bold text-white">C</span>
            <span class="truncate text-sm font-semibold tracking-tight text-[var(--text-1)]">Cartethyia</span>
          </A>
        </Show>
        <IconButton
          icon={collapsed() ? PanelLeftOpen : PanelLeftClose}
          label={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
          size="sm"
          variant="ghost"
          onClick={toggleCollapsed}
        />
      </div>

      <nav class="flex-1 overflow-y-auto px-2 py-2" aria-label="Primary">
        <For each={sections()}>
          {(section, sectionIndex) => (
            <div class={cn("mb-3", sectionIndex() > 0 && "border-t border-[var(--inner-border)] pt-3")}>
              <Show when={section.title && !collapsed()}>
                {(title) => (
                  <div class="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
                    {title()}
                  </div>
                )}
              </Show>
              <ul class="flex flex-col gap-0.5">
                <For each={section.items}>
                  {(item) => {
                    const Icon = item.icon;
                    const active = (): boolean => isActive(item.href);
                    return (
                      <li>
                        <A
                          href={item.href}
                          aria-current={active() ? "page" : undefined}
                          aria-label={collapsed() ? item.label : undefined}
                          title={collapsed() ? item.label : undefined}
                          class={cn(
                            "group flex h-9 items-center gap-2 rounded-lg px-2 text-xs font-medium outline-none transition-colors duration-150",
                            focusRingClasses,
                            active()
                              ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                              : "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]",
                            collapsed() && "justify-center",
                          )}
                        >
                          <Icon size={16} aria-hidden="true" class="shrink-0" />
                          <Show when={!collapsed()}>
                            <span class="min-w-0 flex-1 truncate">{item.label}</span>
                          </Show>
                          <Show when={!collapsed() && item.status}>
                            {(status) => <StatusIndicator status={indicatorStatus(status())} aria-hidden="true" />}
                          </Show>
                        </A>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </div>
          )}
        </For>
      </nav>

      <div class="border-t border-[var(--inner-border)] p-2">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme() === "dark" ? "light" : "dark"} theme`}
          class={cn(
            "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-xs font-medium text-[var(--text-2)] outline-none transition-colors duration-150 hover:bg-[var(--hover)] hover:text-[var(--text-1)]",
            focusRingClasses,
            collapsed() && "justify-center",
          )}
        >
          <span aria-hidden="true" class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--inner-border)]">
            <span class={cn("h-2.5 w-2.5 rounded-full transition-colors duration-150", theme() === "dark" ? "bg-[var(--accent)]" : "bg-[var(--status-warning)]")} />
          </span>
          <Show when={!collapsed()}>
            <span class="truncate">{theme() === "dark" ? "Dark" : "Light"} theme</span>
          </Show>
        </button>
        <Show when={!collapsed() && props.footer}>
          {(footer) => <div class="mt-2">{footer()}</div>}
        </Show>
      </div>
    </aside>
  );
}
