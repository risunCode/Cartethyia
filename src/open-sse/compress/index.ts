import type { ContentBlock, NormalizedMessage, ProxyRequest } from "../../domain/contracts";
import { autoDetectFilter, type RtkFilter } from "./autodetect";

export type TokenSaverQuality = "lite" | "balanced" | "extreme";
export { autoDetectFilter, type RtkFilter } from "./autodetect";

export interface TokenSaverConfig {
  readonly enabled: boolean;
  readonly quality: TokenSaverQuality;
  readonly smartTruncate?: boolean;
}

const QUALITY_LIMITS: Record<TokenSaverQuality, { readonly maxChars: number; readonly keepLastTurns: number }> = {
  lite: { maxChars: 8_000, keepLastTurns: 3 },
  balanced: { maxChars: 4_000, keepLastTurns: 2 },
  extreme: { maxChars: 2_000, keepLastTurns: 1 },
};
const MIN_COMPRESSIBLE = 500;
const HUNK_RE = /^@@ .+ @@/;
const GREP_RE = /^[^\s:]+:\d+:/;

function generic(text: string, maxChars: number): string {
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.max(0, maxChars - headSize - 80);
  const tail = tailSize > 0 ? text.slice(-tailSize) : "";
  const dropped = text.length - headSize - tail.length;
  const lines = (text.slice(headSize, text.length - tail.length).match(/\n/g) ?? []).length;
  return `${text.slice(0, headSize)}\n\n…[truncated ${dropped} chars / ~${lines} lines]…\n\n${tail}`;
}

function gitDiff(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (!HUNK_RE.test(lines[index] ?? "")) { output.push(lines[index] ?? ""); index += 1; continue; }
    const start = index;
    index += 1;
    while (index < lines.length && !HUNK_RE.test(lines[index] ?? "") && !lines[index]?.startsWith("diff --git ")) index += 1;
    const hunk = lines.slice(start, index);
    output.push(...(hunk.length <= 11 ? hunk : [hunk[0] ?? "", ...hunk.slice(1, 6), `…[${hunk.length - 11} hunk lines elided]…`, ...hunk.slice(-5)]));
  }
  const result = output.join("\n");
  return result.length > maxChars ? generic(result, maxChars) : result;
}

function gitStatus(text: string): string {
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  let branch = "";
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("On branch ")) branch = line.slice(10);
    if (line.startsWith("## ")) branch = line.slice(3);
    if (/^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const path = raw.slice(3);
      if (raw.startsWith("?? ")) untracked.push(path);
      else { if ("MADRC".includes(raw[0] ?? "")) staged.push(path); if ((raw[1] ?? "") === "M") modified.push(path); }
    }
  }
  if (staged.length + modified.length + untracked.length === 0) return text;
  const section = (label: string, entries: string[]) => entries.length === 0 ? [] : [`${label}: ${entries.length}`, ...entries.slice(0, 10).map((entry) => `  ${entry}`), ...(entries.length > 10 ? [`  … +${entries.length - 10} more`] : [])];
  return [branch ? `* ${branch}` : "", ...section("Staged", staged), ...section("Modified", modified), ...section("Untracked", untracked)].filter(Boolean).join("\n");
}

function tree(text: string, maxChars: number): string {
  const kept: string[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    const indent = (line.match(/^[│ ]*/) ?? [""])[0].length / 2;
    if (indent <= 1) kept.push(line); else dropped += 1;
    if (kept.join("\n").length > maxChars - 100) break;
  }
  return `${kept.join("\n")}\n…[${dropped} deeper entries collapsed]…`;
}

function readNumbered(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  const head: string[] = []; const tail: string[] = [];
  let headSize = 0; let tailSize = 0;
  for (const line of lines) { if (headSize + line.length > maxChars * 0.6) break; head.push(line); headSize += line.length + 1; }
  for (let index = lines.length - 1; index >= 0; index -= 1) { const line = lines[index] ?? ""; if (tailSize + line.length > maxChars * 0.3) break; tail.unshift(line); tailSize += line.length + 1; }
  return [...head, `…[${Math.max(0, lines.length - head.length - tail.length)} numbered lines elided]…`, ...tail].join("\n");
}

function grep(text: string, maxChars: number): string {
  const lines = text.split("\n");
  const groups = new Map<string, string[]>();
  for (const line of lines) { const match = line.match(/^([^\s:]+):(\d+):(.*)$/); if (!match) continue; const path = match[1] ?? "unknown"; const current = groups.get(path) ?? []; current.push(`${match[2]}: ${(match[3] ?? "").trim()}`); groups.set(path, current); }
  if (groups.size === 0) return text;
  const output: string[] = ["RTK grep summary:"];
  for (const [path, matches] of groups) { output.push(`[${path}] (${matches.length})`, ...matches.slice(0, 5).map((match) => `  ${match}`)); if (matches.length > 5) output.push(`  … +${matches.length - 5} more`); if (output.join("\n").length > maxChars) break; }
  return output.join("\n");
}

function dedupLog(text: string): string {
  const output: string[] = []; let previous: string | undefined; let duplicates = 0;
  const flush = () => { if (duplicates > 0) output.push(`  … (${duplicates} duplicate ${duplicates === 1 ? "line" : "lines"})`); };
  for (const line of text.split("\n")) { if (line === previous) { duplicates += 1; continue; } flush(); output.push(line); previous = line; duplicates = 0; }
  flush(); return output.join("\n");
}

function smartTruncate(text: string, maxChars: number, smart: boolean): { text: string; filter: RtkFilter | null } {
  if (text.length < MIN_COMPRESSIBLE) return { text, filter: null };
  const probe = text.slice(0, 1_024);
  const fits = text.length <= maxChars;
  const candidates: Array<{ filter: RtkFilter; detect: boolean; apply: () => string; lossless?: boolean }> = [
    { filter: "git-diff", detect: /^(diff --git |index |---|\+\+\+)/m.test(probe), apply: () => gitDiff(text, maxChars) },
    { filter: "git-status", detect: /^(On branch |## |Untracked files:|Changes )/m.test(probe) || /^[ MADRCU?!][ MADRCU?!] /m.test(probe), apply: () => gitStatus(text) },
    { filter: "tree", detect: (probe.match(/^[│ ]*[├└]── /gm) ?? []).length >= 5, apply: () => tree(text, maxChars) },
    { filter: "read-numbered", detect: (probe.match(/^\s*\d+[→|\t]\s/gm) ?? []).length >= 3, apply: () => readNumbered(text, maxChars) },
    { filter: "grep", detect: (probe.match(GREP_RE) ?? []).length >= 5, apply: () => grep(text, maxChars) },
    { filter: "dedup-log", detect: (probe.split("\n").slice(0, 100).filter((line, index, all) => index > 0 && line === all[index - 1])).length >= 3, apply: () => dedupLog(text), lossless: true },
  ];
  if (smart) {
    const detected = autoDetectFilter(text);
    const ordered = detected === null ? candidates : [...candidates.filter((candidate) => candidate.filter === detected), ...candidates.filter((candidate) => candidate.filter !== detected)];
    for (const candidate of ordered) {
      if ((fits && !candidate.lossless) || !candidate.detect) continue;
      const result = candidate.apply();
      if (result.length < text.length) return { text: result, filter: candidate.filter };
    }
  }
  return fits ? { text, filter: null } : { text: generic(text, maxChars), filter: "generic" };
}

/** Applies the full RTK smart-filter pipeline to older tool results. */
export function applyTokenSaver(request: ProxyRequest, config: TokenSaverConfig): ProxyRequest {
  if (!config.enabled || request.messages.length === 0) return request;
  const limits = QUALITY_LIMITS[config.quality];
  const cutoff = Math.max(0, request.messages.length - limits.keepLastTurns * 2);
  const messages: readonly NormalizedMessage[] = request.messages.map((message, index) => {
    if (index >= cutoff) return message;
    let changed = false;
    const content = message.content.map((block: ContentBlock) => {
      if (block.type !== "tool_result" || typeof block.text !== "string") return block;
      const result = smartTruncate(block.text, limits.maxChars, config.smartTruncate !== false);
      if (result.text === block.text) return block;
      changed = true;
      return { ...block, text: result.text };
    });
    return changed ? { ...message, content } : message;
  });
  return { ...request, messages };
}
