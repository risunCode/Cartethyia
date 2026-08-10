import {
  Boxes,
  Cable,
  ChartSpline,
  Coins,
  Database,
  Filter,
  Gauge,
  Globe,
  LayoutDashboard,
  Layers,
  MessageSquare,
  Settings,
  SlidersHorizontal,
  Terminal,
  TerminalSquare,
  Workflow,
} from "lucide-react";

export interface NavEntry {
  to: string;
  label: string;
  icon: typeof Boxes;
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

export const ADVANCED_NAV_GROUPS: { label: string; items: NavEntry[]; soon?: boolean }[] = [
  {
    label: "General",
    items: [
      { to: "/advanced", label: "Customization", icon: SlidersHorizontal },
      { to: "/advanced/filter-sanitize", label: "Filter Sanitize", icon: Filter },
      { to: "/advanced/token-saver", label: "Token Saver", icon: Coins },
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
      { to: "/advanced/warp", label: "MultiWarp", icon: Globe },
      { to: "/advanced/cli-tools", label: "CLI Tools", icon: TerminalSquare },
      { to: "/advanced/automation", label: "Automation", icon: Workflow, badge: "Soon" },
    ],
  },
];

export const ADVANCED_PATHS = new Set(["/advanced", ...ADVANCED_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to))]);

export const TITLES: Record<string, { title: string; sub: string; mobileSub: string }> = {
  "/overview": { title: "Overview", sub: "Traffic, endpoints, and fast shortcuts", mobileSub: "Traffic & shortcuts" },
  "/usage": { title: "Usage", sub: "Usage summary and request overview", mobileSub: "Request activity" },
  "/providers": { title: "Providers", sub: "All supported AI providers", mobileSub: "All AI providers" },
  "/model-studio": { title: "Model Studio", sub: "Chat-test any provider, model, or combo live", mobileSub: "Test models live" },
  "/combos": { title: "Combos & Alias", sub: "Fallback, round-robin, alias model", mobileSub: "Fallback & aliases" },
  "/quota": { title: "Quota Management", sub: "Provider account limits and reset windows", mobileSub: "Quota & resets" },
  "/proxy-requests": { title: "Proxy & Requests", sub: "Routing and request policy controls", mobileSub: "Proxy controls" },
  "/console-log": { title: "Console Log", sub: "Live log stream", mobileSub: "Live log stream" },
  "/advanced": { title: "Customization", sub: "Background, sidebar icon, and appearance controls", mobileSub: "Appearance" },
  "/advanced/filter-sanitize": { title: "Filter Sanitize", sub: "Reasoning tag stripping and response content filtering", mobileSub: "Filter" },
  "/advanced/token-saver": { title: "Token Saver", sub: "Reduce token usage with compact encoding and caching", mobileSub: "Tokens" },
  "/advanced/db-map": { title: "Database Map", sub: "Inspect and query console databases", mobileSub: "Database map" },
  "/advanced/warp": { title: "MultiWarp", sub: "Cloudflare Warp account pool and egress instances", mobileSub: "Warp pool" },
  "/advanced/cli-tools": { title: "CLI Tools", sub: "Configure CLI tools for terminal access", mobileSub: "CLI config" },
  "/advanced/cli-tools/:toolId": { title: "CLI Tool", sub: "Tool configuration", mobileSub: "Tool config" },
  "/settings": { title: "Settings", sub: "Security, backup, runtime toggles", mobileSub: "Security & runtime" },
};
