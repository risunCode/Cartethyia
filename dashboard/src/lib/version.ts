/**
 * Single Source of Truth for Dashboard client release metadata.
 * Imports version directly from dashboard/package.json.
 */
import pkg from "../../package.json";

export const DASHBOARD_VERSION = pkg.version;
export const DASHBOARD_CODENAME = "Shorekeeper";
export const DASHBOARD_RELEASE_LABEL = `v${DASHBOARD_VERSION} (${DASHBOARD_CODENAME})`;
