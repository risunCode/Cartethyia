/**
 * Canonical usage-period presets: the fixed options the dashboard offers.
 * A subset of what `isSupportedUsagePeriod` accepts (any `\d+[hd]` token) —
 * the single home for the preset list + type so the UI never hardcodes its
 * own union.
 *
 * This module is intentionally free of Elysia / node:crypto so the dashboard
 * codegen can import the constant without bundling the backend graph.
 */
export const USAGE_PERIODS = ["1h", "6h", "12h", "24h", "7d", "30d", "all"] as const;

/** One dashboard usage-period preset. */
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
