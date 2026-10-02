// Tunables for request-history compression (RTK). Constants beside the code,
// not env knobs: these are safety margins, not deployment settings.

/** Skip blobs smaller than this — compressing tiny tool results only adds noise. */
export const RTK_MIN_COMPRESS_SIZE = 500;
/** Never touch a blob larger than this; a multi-megabyte dump is not a tool result to prune. */
export const RTK_RAW_CAP = 10 * 1024 * 1024;
/** How many leading characters autodetect inspects when classifying a blob. */
export const RTK_DETECT_WINDOW = 1024;

/**
 * Compression strength. Higher levels shrink more aggressively and therefore
 * risk more fidelity, which is why the level is an explicit operator choice:
 *
 *  - `lite`  — only the type-specific structural filters (diff, grep, ls, …),
 *              and only on larger blobs. A generic log is left untouched.
 *  - `full`  — the structural filters plus the generic fallbacks (dedup-log,
 *              smart-truncate) at the standard size gate. The default.
 *  - `ultra` — a lower size gate so smaller blobs qualify, plus a second
 *              generic pass over an already-filtered blob to squeeze further.
 */
export const RTK_LEVELS = ["lite", "full", "ultra"] as const;
export type RtkLevel = (typeof RTK_LEVELS)[number];

export interface RtkProfile {
  /** Blobs smaller than this are left alone at this level. */
  readonly minSize: number;
  /** Whether the generic fallbacks (dedup-log, smart-truncate) may classify a blob. */
  readonly genericFallback: boolean;
  /** Whether a second, generic pass runs over a structurally-filtered blob. */
  readonly secondPass: boolean;
}

export const RTK_PROFILES: Readonly<Record<RtkLevel, RtkProfile>> = Object.freeze({
  lite: { minSize: 800, genericFallback: false, secondPass: false },
  full: { minSize: RTK_MIN_COMPRESS_SIZE, genericFallback: true, secondPass: false },
  ultra: { minSize: 200, genericFallback: true, secondPass: true },
});

/** The tuning profile for a level, defaulting to `full` for an unknown value. */
export function rtkProfile(level: RtkLevel | null | undefined): RtkProfile {
  return RTK_PROFILES[level ?? "full"] ?? RTK_PROFILES.full;
}

/** git-diff: context lines kept around each change. */
export const GIT_DIFF_CONTEXT_KEEP = 3;
/** git-diff: per-hunk line cap before truncating the middle. */
export const GIT_DIFF_HUNK_MAX_LINES = 100;
/** git-log: total line cap. */
export const GIT_LOG_MAX_LINES = 200;
/** Generic log dedup: hard output line cap. */
export const DEDUP_LINE_MAX = 2000;

/** grep: matches shown per file. */
export const GREP_PER_FILE_MAX = 10;
/** find: entries shown per directory. */
export const FIND_PER_DIR_MAX = 10;
/** find: directories shown. */
export const FIND_TOTAL_DIR_MAX = 20;
/** ls: top extensions listed in the summary. */
export const LS_EXT_SUMMARY_TOP = 5;
/** tree: total line cap. */
export const TREE_MAX_LINES = 200;
/** Cursor-style search list: entries per directory / total directories. */
export const SEARCH_LIST_PER_DIR_MAX = 10;
export const SEARCH_LIST_TOTAL_DIR_MAX = 20;
/** smart-truncate: lines kept from the head and tail. */
export const SMART_TRUNCATE_HEAD = 120;
export const SMART_TRUNCATE_TAIL = 60;
/** smart-truncate only engages above this line count. */
export const SMART_TRUNCATE_MIN_LINES = 250;
/** read-numbered: fraction of lines that must look line-numbered to classify. */
export const READ_NUMBERED_MIN_HIT_RATIO = 0.7;

/** Directory names that are noise in an `ls`/`tree` dump. */
export const LS_NOISE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "target",
  "__pycache__",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".vercel",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  "coverage",
  ".nyc_output",
  ".idea",
  ".vscode",
  ".vs",
]);
