import {
  Cable,
  ChartSpline,
  Gauge,
  LayoutDashboard,
  Settings,
  SlidersHorizontal,
  Terminal,
  Workflow,
} from "lucide-react";

export interface NavEntry {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
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
    label: "Control",
    items: [
      { to: "/quota", label: "Quota Management", icon: Gauge },
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

export const ADVANCED_NAV_GROUPS: { label: string; items: NavEntry[]; soon?: boolean }[] = [
  {
    label: "General",
    items: [
      { to: "/advanced", label: "Customization", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Tools",
    items: [
      { to: "/advanced/automation", label: "Automation", icon: Workflow, badge: "Soon" },
    ],
  },
];

export const ADVANCED_PATHS = new Set(["/advanced", ...ADVANCED_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to))]);

export const TITLES: Record<string, { title: string; sub: string; mobileSub: string }> = {
  "/overview": { title: "Overview", sub: "Traffic, endpoints, and fast shortcuts", mobileSub: "Traffic & shortcuts" },
  "/usage": { title: "Usage", sub: "Usage summary and request overview", mobileSub: "Request activity" },
  "/providers": { title: "Providers", sub: "All supported AI providers", mobileSub: "All AI providers" },
  "/quota": { title: "Quota Management", sub: "Provider account limits and reset windows", mobileSub: "Quota & resets" },
  "/console-log": { title: "Console Log", sub: "Live log stream", mobileSub: "Live log stream" },
  "/advanced": { title: "Customization", sub: "Background, sidebar icon, and appearance controls", mobileSub: "Appearance" },
  "/advanced/automation": { title: "Automation", sub: "Automation controls", mobileSub: "Automation" },
  "/settings": { title: "Settings", sub: "Security, backup, runtime toggles", mobileSub: "Security & runtime" },
};
