/**
 * Single Source of Truth for Dashboard client release metadata.
 *
 * Reads the root manifest, not the dashboard's own copy. The dashboard is
 * bundled into the gateway and released with it, so a second version field has
 * nothing to contribute and can only drift — and it did: the sidebar kept
 * rendering `v2.1 (Zhezhi)` in a 2.2 install because the root was bumped while
 * `dashboard/package.json` was not, and no check compared the two.
 */
import pkg from "../../../package.json";

export const DASHBOARD_VERSION = pkg.version;
export const DASHBOARD_CODENAME = "Zhezhi";
export const DASHBOARD_RELEASE_LABEL = `v${DASHBOARD_VERSION} (${DASHBOARD_CODENAME})`;
