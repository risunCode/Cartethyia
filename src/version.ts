import pkg from "../package.json";

/**
 * Single Source of Truth for Cartethyia versioning and release metadata.
 * All runtime endpoints, observability stores, and metadata helpers import
 * from here. Lives at the repo root (not under `transport/`) because the
 * version string is leaf metadata consumed by `console/observability/store`,
 * `providers/operations/gateway-user-agent`, and the gateway health route —
 * none of which are transport concerns.
 */
export const CARTETHYIA_VERSION = pkg.version;
