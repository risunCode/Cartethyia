import pkg from "../../package.json";

/**
 * Single Source of Truth for Cartethyia versioning and release metadata.
 * All runtime endpoints, observability stores, and metadata helpers import from here.
 */
export const CARTETHYIA_VERSION = pkg.version;
