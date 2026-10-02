/**
 * RTK content filters — compact a bulky tool-result blob (a diff, a grep dump,
 * a directory listing) into a shorter, still-faithful form before it is sent
 * back upstream.
 *
 * Each filter is pure: text in, text out. A filter that would return empty,
 * throw, or grow the input is rejected by `safeApplyFilter`, which falls back
 * to the raw text — a filter can never corrupt a request, only shorten it.
 *
 * `autoDetectFilter` classifies a blob by its first `RTK_DETECT_WINDOW`
 * characters and picks the matching filter, in a fixed order: a diff is checked
 * before a grep, a build log before a git-status porcelain block (a cargo
 * `Compiling …` line looks porcelain-shaped and must not be mistaken for it).
 */
import {
  DEDUP_LINE_MAX,
  FIND_PER_DIR_MAX,
  FIND_TOTAL_DIR_MAX,
  GIT_DIFF_HUNK_MAX_LINES,
  GIT_LOG_MAX_LINES,
  GREP_PER_FILE_MAX,
  LS_EXT_SUMMARY_TOP,
  LS_NOISE_DIRS,
  READ_NUMBERED_MIN_HIT_RATIO,
  RTK_DETECT_WINDOW,
  SMART_TRUNCATE_HEAD,
  SMART_TRUNCATE_MIN_LINES,
  SMART_TRUNCATE_TAIL,
  TREE_MAX_LINES,
} from "./rtk-constants";

export type RtkFilter = ((input: string) => string) & { filterName?: string };

/** `git diff` → per-file header, per-hunk truncation, +/- counts. */
export const gitDiffFilter: RtkFilter = (diff) => {
  const result: string[] = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let hunkShown = 0;
  let hunkSkipped = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        hunkSkipped = 0;
      }
      if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
      const parts = line.split(" b/");
      currentFile = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      hunkShown = 0;
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        hunkSkipped = 0;
      }
      hunkShown = 0;
      result.push(line);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
      if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) result.push(line);
      else hunkSkipped++;
      hunkShown++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
      if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) result.push(line);
      else hunkSkipped++;
      hunkShown++;
    } else if (hunkShown > 0) {
      // Context line inside a hunk.
      if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) result.push(line);
      else hunkSkipped++;
      hunkShown++;
    }
  }
  if (hunkSkipped > 0) result.push(`  ... (${hunkSkipped} lines truncated)`);
  if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
  return result.join("\n").replace(/^\n/, "");
};
gitDiffFilter.filterName = "git-diff";

/** `git log` → one line per commit, capped. */
export const gitLogFilter: RtkFilter = (input) => {
  const lines = input.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^[*|/\\ ]*commit [0-9a-f]{7,40}$/.test(line)) {
      out.push(`\n${line.replace(/^[*|/\\ ]+/, "")}`);
    } else if (/^(Author|Date|Merge):/.test(line) || line.startsWith("    ")) {
      if (out.length < GIT_LOG_MAX_LINES) out.push(line);
    }
    if (out.length >= GIT_LOG_MAX_LINES) break;
  }
  return out.join("\n").replace(/^\n/, "");
};
gitLogFilter.filterName = "git-log";

/** `git status` → branch line, changed-file counts, file list capped. */
export const gitStatusFilter: RtkFilter = (input) => {
  const lines = input.split("\n");
  const out: string[] = [];
  let changed = 0;
  for (const line of lines) {
    if (line.startsWith("On branch ") || line.startsWith("Your branch ")) {
      out.push(line);
    } else if (line.startsWith("Changes ") || line.startsWith("Untracked files:")) {
      out.push(`\n${line}`);
    } else if (/^[ MADRCU?!][ MADRCU?!] /.test(line)) {
      changed++;
      if (changed <= 20) out.push(`  ${line}`);
    }
  }
  if (changed > 20) out.push(`  ... (${changed - 20} more files)`);
  return out.join("\n").replace(/^\n/, "");
};
gitStatusFilter.filterName = "git-status";

/** `grep`/`rg` dump (`file:line:content`) → grouped by file, capped per file. */
export const grepFilter: RtkFilter = (input) => {
  const byFile = new Map<string, Array<[string, string]>>();
  let total = 0;
  for (const line of input.split("\n")) {
    const first = line.indexOf(":");
    if (first === -1) continue;
    const second = line.indexOf(":", first + 1);
    if (second === -1) continue;
    const file = line.slice(0, first);
    const lineNum = line.slice(first + 1, second);
    if (!/^\d+$/.test(lineNum)) continue;
    total++;
    const bucket = byFile.get(file) ?? [];
    bucket.push([lineNum, line.slice(second + 1)]);
    byFile.set(file, bucket);
  }
  if (total === 0) return input;
  const files = [...byFile.keys()].sort();
  let out = `${total} matches in ${files.length} files:\n`;
  for (const file of files) {
    const matches = byFile.get(file)!;
    out += `\n${file} (${matches.length}):\n`;
    for (const [num, content] of matches.slice(0, GREP_PER_FILE_MAX)) {
      out += `  ${num.padStart(4)}: ${content.trim()}\n`;
    }
    if (matches.length > GREP_PER_FILE_MAX) out += `  +${matches.length - GREP_PER_FILE_MAX} more\n`;
  }
  return out.trimEnd();
};
grepFilter.filterName = "grep";

/** `find` dump (path-per-line) → grouped by parent directory, capped. */
export const findFilter: RtkFilter = (input) => {
  const byDir = new Map<string, string[]>();
  for (const line of input.split("\n")) {
    const path = line.trim();
    if (!path) continue;
    const idx = path.lastIndexOf("/");
    const dir = idx === -1 ? "." : path.slice(0, idx);
    const base = idx === -1 ? path : path.slice(idx + 1);
    const bucket = byDir.get(dir) ?? [];
    bucket.push(base);
    byDir.set(dir, bucket);
  }
  const dirs = [...byDir.keys()].sort().slice(0, FIND_TOTAL_DIR_MAX);
  const out: string[] = [];
  for (const dir of dirs) {
    const files = byDir.get(dir)!;
    out.push(`${dir}/ (${files.length})`);
    for (const base of files.slice(0, FIND_PER_DIR_MAX)) out.push(`  ${base}`);
    if (files.length > FIND_PER_DIR_MAX) out.push(`  +${files.length - FIND_PER_DIR_MAX} more`);
  }
  if (byDir.size > FIND_TOTAL_DIR_MAX) out.push(`... +${byDir.size - FIND_TOTAL_DIR_MAX} more directories`);
  return out.join("\n");
};
findFilter.filterName = "find";

/** `ls -la` dump → directories and files with human sizes, noise dirs dropped. */
export const lsFilter: RtkFilter = (input) => {
  const dirs: string[] = [];
  const files: Array<[string, number]> = [];
  const byExt = new Map<string, number>();
  const dateRe = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;
  for (const line of input.split("\n")) {
    if (line.startsWith("total ") || line.length === 0) continue;
    const m = dateRe.exec(line);
    if (!m) continue;
    const name = line.slice(m.index + m[0].length).trim();
    if (!name || LS_NOISE_DIRS.has(name)) continue;
    const before = line.slice(0, m.index).split(/\s+/).filter(Boolean);
    if (before.length < 4) continue;
    const perms = before[0] ?? "";
    if (perms.startsWith("d")) {
      dirs.push(name);
      continue;
    }
    let size = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      const n = Number(before[i]);
      if (Number.isInteger(n) && String(n) === before[i]) {
        size = n;
        break;
      }
    }
    files.push([name, size]);
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "(none)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const human = (bytes: number): string =>
    bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)}M` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${bytes}B`;
  const out: string[] = [];
  for (const dir of dirs) out.push(`${dir}/`);
  for (const [name, size] of files) out.push(`${name}  ${human(size)}`);
  const topExt = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, LS_EXT_SUMMARY_TOP);
  if (topExt.length > 0) out.push(`\n${files.length} files · ${topExt.map(([e, c]) => `${e}:${c}`).join(" ")}`);
  return out.join("\n");
};
lsFilter.filterName = "ls";

/** `tree` dump → collapsed, noise dirs dropped, capped. */
export const treeFilter: RtkFilter = (input) => {
  const out: string[] = [];
  for (const line of input.split("\n")) {
    const trimmed = line.replace(/[│├└─]/g, " ").trim();
    const name = trimmed.split(/\s+/).pop() ?? "";
    if (LS_NOISE_DIRS.has(name)) continue;
    out.push(line);
    if (out.length >= TREE_MAX_LINES) {
      out.push(`... (truncated at ${TREE_MAX_LINES} lines)`);
      break;
    }
  }
  return out.join("\n");
};
treeFilter.filterName = "tree";

/** Generic log → consecutive duplicate lines collapsed, blank runs collapsed, capped. */
export const dedupLogFilter: RtkFilter = (input) => {
  const lines = input.split("\n");
  const out: string[] = [];
  let prev: string | null = null;
  let runCount = 0;
  let blankStreak = 0;
  const flushRun = () => {
    if (prev !== null && runCount > 1) out.push(`  ... (${runCount - 1} duplicate lines)`);
  };
  for (const line of lines) {
    if (line.trim() === "") {
      if (blankStreak < 1) out.push(line);
      blankStreak++;
      flushRun();
      prev = null;
      runCount = 0;
      continue;
    }
    blankStreak = 0;
    if (line === prev) {
      runCount++;
      continue;
    }
    flushRun();
    out.push(line);
    prev = line;
    runCount = 1;
    if (out.length >= DEDUP_LINE_MAX) {
      out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
      return out.join("\n");
    }
  }
  flushRun();
  return out.join("\n");
};
dedupLogFilter.filterName = "dedup-log";

/** Last resort: keep the head and tail lines, elide the middle. */
export const smartTruncateFilter: RtkFilter = (input) => {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join("\n");
};
smartTruncateFilter.filterName = "smart-truncate";

const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_TREE_GLYPH = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;
const RE_READ_NUMBERED = /^\s*\d+\|/;

function isGrepLine(line: string): boolean {
  const first = line.indexOf(":");
  if (first === -1) return false;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return false;
  return /^\d+$/.test(line.slice(first + 1, second));
}

function isPathLike(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(":")) return false;
  return t.startsWith(".") || t.startsWith("/") || t.includes("/");
}

function isMostlyPorcelain(head: string): boolean {
  const lines = head.split("\n").filter((l) => l.trim());
  if (lines.length < 3) return false;
  return lines.filter((l) => RE_PORCELAIN.test(l)).length / lines.length >= 0.6;
}

function isLineNumbered(lines: readonly string[]): boolean {
  let hits = 0;
  let nonEmpty = 0;
  for (const l of lines.slice(0, 100)) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (RE_READ_NUMBERED.test(l)) hits++;
  }
  return nonEmpty >= 5 && hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}

/** Classifies a blob and returns the filter that fits, or `null` for no match.
 *
 * `genericFallback` gates the last two, content-agnostic filters (dedup-log,
 * smart-truncate): at `lite` strength they are withheld, so an unrecognized
 * blob is passed through rather than heuristically truncated. */
export function autoDetectFilter(
  text: string,
  options?: { readonly genericFallback?: boolean },
): RtkFilter | null {
  const genericFallback = options?.genericFallback !== false;
  const head = text.length > RTK_DETECT_WINDOW ? text.slice(0, RTK_DETECT_WINDOW) : text;
  if (RE_GIT_LOG.test(head)) return gitLogFilter;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiffFilter;
  if (RE_GIT_STATUS.test(head)) return gitStatusFilter;
  if (isMostlyPorcelain(head)) return gitStatusFilter;

  const nonEmpty = head.split("\n").filter((l) => l.trim().length > 0);
  if (nonEmpty.slice(0, 5).some(isGrepLine)) return grepFilter;
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return findFilter;
  if (RE_TREE_GLYPH.test(head)) return treeFilter;
  if (RE_LS_TOTAL.test(head) || (head.match(new RegExp(RE_LS_ROW.source, "gm")) ?? []).length >= 3)
    return lsFilter;
  if (head.split("\n").length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(head.split("\n")))
    return smartTruncateFilter;
  if (!genericFallback) return null;
  if (nonEmpty.length >= 5) return dedupLogFilter;
  if (text.split("\n").length >= SMART_TRUNCATE_MIN_LINES) return smartTruncateFilter;
  return null;
}

/**
 * Runs a filter with a fail-open guarantee: a filter that throws, returns a
 * non-string, returns empty, or returns something not shorter than its input
 * is discarded and the raw text is kept. A filter can only ever shorten.
 */
export function safeApplyFilter(filter: RtkFilter, text: string): string {
  try {
    const out = filter(text);
    if (typeof out !== "string" || out.length === 0 || out.length >= text.length) return text;
    return out;
  } catch {
    return text;
  }
}
