export type RtkFilter = "git-diff" | "git-status" | "tree" | "read-numbered" | "grep" | "dedup-log" | "generic";

const DETECT_WINDOW = 8_192;
const RE_GIT_DIFF = /^diff --git |^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_TREE = /[├└]──|│  /;
const RE_LS = /^[-dlbcps][rwx-]{9}/m;
const RE_GREP = /^[^\s:]+:\d+:/;
const RE_NUMBERED = /^\s*\d+[→|\t]\s/;

/** Detects the loss-aware RTK filter best suited to a tool result. */
export function autoDetectFilter(text: string): RtkFilter | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
  if (RE_GIT_DIFF.test(head)) return "git-diff";
  if (RE_GIT_STATUS.test(head) || isMostlyPorcelain(head)) return "git-status";
  const lines = head.split("\n");
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.slice(0, 5).some((line) => RE_GREP.test(line))) return "grep";
  if (nonEmpty.length >= 3 && nonEmpty.every((line) => isPathLike(line))) return "tree";
  if (RE_TREE.test(head) || RE_LS.test(head)) return "tree";
  if (lines.length >= 5 && lines.filter((line) => line.length > 0 && RE_NUMBERED.test(line)).length / Math.max(1, nonEmpty.length) >= 0.6) return "read-numbered";
  if (hasAdjacentDuplicates(nonEmpty)) return "dedup-log";
  return null;
}

function isMostlyPorcelain(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 3) return false;
  return lines.filter((line) => RE_PORCELAIN.test(line)).length / lines.length >= 0.6;
}
function isPathLike(line: string): boolean {
  const value = line.trim();
  if (value.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.includes(":")) return false;
  return value.startsWith(".") || value.startsWith("/") || value.includes("/");
}

function hasAdjacentDuplicates(lines: readonly string[]): boolean {
  let duplicates = 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === lines[index - 1]) duplicates += 1;
  }
  return duplicates >= 3;
}
