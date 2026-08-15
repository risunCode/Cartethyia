import {
  Cable,
  ChartSpline,
  LayoutDashboard,
  Settings,
} from "lucide-solid";
import type { Component } from "solid-js";

export interface NavEntry {
  to: string;
  label: string;
  icon: Component<{ size?: number; class?: string; "aria-hidden"?: boolean }>;
  badge?: string;
  /** When set, clicking this entry switches the sidebar page instead of navigating. */
  switchTo?: 0 | 1;
}

export const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "Main",
    items: [
      { to: "/overview", label: "Overview", icon: LayoutDashboard },
      { to: "/usage", label: "Usage", icon: ChartSpline },
      { to: "/providers", label: "Providers", icon: Cable },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export const TITLES: Record<string, { title: string; sub: string; mobileSub: string }> = {
  "/overview": { title: "Overview", sub: "Traffic, endpoints, and fast shortcuts", mobileSub: "Traffic & shortcuts" },
  "/usage": { title: "Usage", sub: "Usage summary and request overview", mobileSub: "Request activity" },
  "/providers": { title: "Providers", sub: "All supported AI providers", mobileSub: "All AI providers" },
  "/settings": { title: "Settings", sub: "Security, backup, runtime toggles", mobileSub: "Security & runtime" },
};
