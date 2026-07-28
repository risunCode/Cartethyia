/**
 * Outbound request transforms, applied exactly once immediately before an
 * upstream fetch. Keeping them after format translation means the same
 * behavior covers native forwarding and every cross-provider route.
 *
 * RTK is deliberately opt-in because its reductions are lossy. It only
 * touches successful tool results, detects recognizable command-output
 * shapes, and preserves the original whenever a filter fails, empties, or
 * grows the text. The system prompt is server-controlled configuration —
 * client request fields cannot enable or replace it.
 */

export type UpstreamFormat = "openai" | "anthropic";

export interface RequestTransformSettings {
  rtk: {
    enabled: boolean;
    minChars: number;
    maxReductionPercent: number;
  };
  systemPrompt: string | undefined;
}

export interface RtkStats {
  textBlocksSeen: number;
  textBlocksCompressed: number;
  charactersBefore: number;
  charactersAfter: number;
  filters: string[];
}

type JsonObject = Record<string, unknown>;
type TextFilter = (text: string) => string;

const RAW_CAP = 10 * 1024 * 1024;
const DETECT_WINDOW = 1024;
const MAX_PER_GROUP = 10;
const MAX_GROUPS = 20;
const TREE_MAX_LINES = 200;
const GIT_DIFF_HUNK_MAX_LINES = 100;
const GIT_LOG_MAX_LINES = 200;
const NOISE_DIRECTORIES = new Set([
  "node_modules", ".git", "target", "__pycache__", ".next", "dist", "build", ".cache", ".turbo",
  ".vercel", ".pytest_cache", ".mypy_cache", ".tox", ".venv", "venv", "env", "coverage",
  ".nyc_output", ".DS_Store", "Thumbs.db", ".idea", ".vscode", ".vs", "*.egg-info", ".eggs",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: JsonObject, key: string): unknown {
  return value[key];
}

function setField(value: JsonObject, key: string, replacement: unknown): void {
  value[key] = replacement;
}

function stringField(value: JsonObject, key: string): string | undefined {
  const candidate = field(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function objectArray(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value) || !value.every(isObject)) return undefined;
  return value;
}

function isTextPart(value: JsonObject): boolean {
  return value.type === "text" || value.type === "input_text";
}

function safeApply(filter: TextFilter, text: string): string {
  try {
    const output = filter(text);
    return typeof output === "string" ? output : text;
  } catch (error) {
    console.warn(`[rtk] ${filter.name || "anonymous"} failed; preserving raw tool output`, error);
    return text;
  }
}

function compactGitDiff(input: string): string {
  const result: string[] = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;

  for (const line of input.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
      const parts = line.split(" b/");
      currentFile = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      inHunk = true;
      hunkShown = 0;
      result.push(`  ${line}`);
    } else if (inHunk) {
      const isAdded = line.startsWith("+") && !line.startsWith("+++");
      const isRemoved = line.startsWith("-") && !line.startsWith("---");
      if (isAdded || isRemoved) {
        if (isAdded) added++;
        if (isRemoved) removed++;
        if (hunkShown < GIT_DIFF_HUNK_MAX_LINES) {
          result.push(`  ${line}`);
          hunkShown++;
        } else {
          hunkSkipped++;
        }
      } else if (hunkShown > 0 && hunkShown < GIT_DIFF_HUNK_MAX_LINES && !line.startsWith("\\")) {
        result.push(`  ${line}`);
        hunkShown++;
      }
    }

    if (result.length >= 500) {
      result.push("\n... (more changes truncated)");
      wasTruncated = true;
      break;
    }
  }

  if (hunkSkipped > 0) {
    result.push(`  ... (${hunkSkipped} lines truncated)`);
    wasTruncated = true;
  }
  if (currentFile && (added > 0 || removed > 0)) result.push(`  +${added} -${removed}`);
  if (wasTruncated) result.push("[full diff available on request]");
  return result.join("\n");
}

function compactGitStatus(input: string): string {
  const stagedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  let branch = "";
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const raw of input.split("\n")) {
    if (!raw.trim()) continue;
    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) {
      branch = longBranch[1] ?? "";
      continue;
    }
    if (raw.startsWith("##")) {
      branch = raw.replace(/^##\s*/, "");
      continue;
    }
    if (/^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const file = raw.slice(3);
      if (raw.slice(0, 2) === "??") {
        untracked++;
        untrackedFiles.push(file);
        continue;
      }
      if ("MADRC".includes(raw[0] ?? "")) {
        staged++;
        stagedFiles.push(file);
      } else if (raw[0] === "U") {
        conflicts++;
      }
      if (raw[1] === "M" || raw[1] === "D") {
        modified++;
        modifiedFiles.push(file);
      }
      continue;
    }
    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (!longMatch) continue;
    const kind = longMatch[1];
    const file = longMatch[2]?.trim() ?? "";
    if (kind === "both modified") conflicts++;
    else if (kind === "modified" || kind === "deleted") {
      modified++;
      modifiedFiles.push(file);
    } else if (kind === "new file" || kind === "renamed") {
      staged++;
      stagedFiles.push(file);
    }
  }

  const renderGroup = (label: string, files: string[], count: number): string[] => {
    if (count === 0) return [];
    const rows = [`${label}: ${count} files`];
    rows.push(...files.slice(0, MAX_PER_GROUP).map((file) => `   ${file}`));
    if (files.length > MAX_PER_GROUP) rows.push(`   ... +${files.length - MAX_PER_GROUP} more`);
    return rows;
  };

  const rows: string[] = [];
  if (branch) rows.push(`* ${branch}`);
  rows.push(...renderGroup("+ Staged", stagedFiles, staged));
  rows.push(...renderGroup("~ Modified", modifiedFiles, modified));
  rows.push(...renderGroup("? Untracked", untrackedFiles, untracked));
  if (conflicts > 0) rows.push(`conflicts: ${conflicts} files`);
  if (rows.length === 0) rows.push("clean — nothing to commit");
  return rows.join("\n");
}

function compactBuildOutput(input: string): string {
  const errors: string[] = [];
  const warnings: string[] = [];
  const deprecations: string[] = [];
  const summary: string[] = [];
  let compilingCount = 0;
  let downloadingCount = 0;
  let inCargoError = false;

  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (inCargoError) {
      if (!trimmed) {
        inCargoError = false;
        continue;
      }
      if (/^\s*(-->|\||\d+\s*\||=)/.test(line)) {
        errors.push(line);
        continue;
      }
      inCargoError = false;
    }
    if (!trimmed) continue;
    if (/^npm (ERR!|error)/i.test(trimmed) || /^yarn error/i.test(trimmed) || /^ERROR:/i.test(trimmed) || /^\[ERROR\]/i.test(trimmed) || /^BUILD FAILED/i.test(trimmed)) {
      errors.push(line);
      continue;
    }
    if (/^error(\[|:)/i.test(trimmed) || trimmed.startsWith("error -->")) {
      errors.push(line);
      inCargoError = true;
      continue;
    }
    if (/^npm warn deprecated/i.test(trimmed)) {
      deprecations.push(line);
      continue;
    }
    if (/^npm warn/i.test(trimmed) || /^yarn warn/i.test(trimmed) || /^warning(\[|:)/i.test(trimmed) || trimmed.startsWith("warning -->") || /^\[WARNING\]/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }
    if (/^\s*Compiling\s+\S+/i.test(trimmed)) {
      compilingCount++;
      continue;
    }
    if (/^\s*Downloading\s+\S+/i.test(trimmed) || /^Fetching\s+/i.test(trimmed)) {
      downloadingCount++;
      continue;
    }
    if (/^(added|removed|changed|audited|installed)\s+\d+\s+package/i.test(trimmed) || /^\s*Finished\s+/i.test(trimmed) || /^BUILD SUCCESS/i.test(trimmed) || /^\d+\s+(vulnerabilities|packages?|warnings?|errors?)/i.test(trimmed) || /^Successfully (installed|built)/i.test(trimmed) || /^To address .* issues/i.test(trimmed) || /^Run `npm (audit|fund)`/i.test(trimmed) || /packages are looking for funding/i.test(trimmed)) {
      summary.push(line);
    }
  }

  const rows: string[] = [];
  rows.push(...deprecations.slice(0, 3));
  if (deprecations.length > 3) rows.push(`... +${deprecations.length - 3} more deprecated packages`);
  if (compilingCount > 0) rows.push(`Compiled ${compilingCount} packages`);
  if (downloadingCount > 0) rows.push(`Downloaded ${downloadingCount} packages`);
  rows.push(...errors);
  rows.push(...warnings.slice(0, 5));
  if (warnings.length > 5) rows.push(`... +${warnings.length - 5} more warnings`);
  rows.push(...summary);
  return rows.join("\n") || input;
}

function compactGrep(input: string): string {
  const byFile = new Map<string, Array<[string, string]>>();
  let total = 0;
  for (const line of input.split("\n")) {
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const lineNumber = line.slice(first + 1, second);
    if (!/^\d+$/.test(lineNumber)) continue;
    const file = line.slice(0, first);
    const matches = byFile.get(file) ?? [];
    matches.push([lineNumber, line.slice(second + 1)]);
    byFile.set(file, matches);
    total++;
  }
  if (total === 0) return input;

  const rows = [`${total} matches in ${byFile.size} files:`, ""];
  for (const file of [...byFile.keys()].sort()) {
    const matches = byFile.get(file) ?? [];
    rows.push(`[file] ${file} (${matches.length}):`);
    rows.push(...matches.slice(0, MAX_PER_GROUP).map(([lineNumber, content]) => `  ${lineNumber.padStart(4)}: ${content.trim()}`));
    if (matches.length > MAX_PER_GROUP) rows.push(`  +${matches.length - MAX_PER_GROUP}`);
    rows.push("");
  }
  return rows.join("\n");
}

function compactPathList(input: string): string {
  const paths = input.split("\n").filter((line) => line.trim());
  if (paths.length === 0) return input;
  const byDirectory = new Map<string, string[]>();
  for (const path of paths) {
    const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const directory = separator === -1 ? "." : path.slice(0, separator) || "/";
    const basename = separator === -1 ? path : path.slice(separator + 1);
    const files = byDirectory.get(directory) ?? [];
    files.push(basename);
    byDirectory.set(directory, files);
  }
  const directories = [...byDirectory.keys()].sort();
  const rows = [`${paths.length} files in ${directories.length} dirs:`, ""];
  for (const directory of directories.slice(0, MAX_GROUPS)) {
    const files = byDirectory.get(directory) ?? [];
    rows.push(`${directory.replace(/\\/g, "/")}/ (${files.length})`);
    rows.push(...files.slice(0, MAX_PER_GROUP).map((file) => `  ${file}`));
    if (files.length > MAX_PER_GROUP) rows.push(`  +${files.length - MAX_PER_GROUP}`);
  }
  if (directories.length > MAX_GROUPS) rows.push(`\n+${directories.length - MAX_GROUPS} more dirs`);
  return rows.join("\n");
}

function compactTree(input: string): string {
  const rows = input
    .split("\n")
    .filter((line) => !(line.includes("director") && line.includes("file")));
  while (rows[0]?.trim() === "") rows.shift();
  while (rows.at(-1)?.trim() === "") rows.pop();
  if (rows.length <= TREE_MAX_LINES) return rows.join("\n");
  return `${rows.slice(0, TREE_MAX_LINES).join("\n")}\n... +${rows.length - TREE_MAX_LINES} more lines`;
}

function compactLs(input: string): string {
  const directories: string[] = [];
  const files: Array<[string, string]> = [];
  const extensions = new Map<string, number>();
  const datePattern = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;

  for (const line of input.split("\n")) {
    if (line.startsWith("total ") || line.length === 0) continue;
    const date = datePattern.exec(line);
    if (!date?.index) continue;
    const name = line.slice(date.index + date[0].length);
    if (name === "." || name === ".." || NOISE_DIRECTORIES.has(name)) continue;
    const parts = line.slice(0, date.index).split(/\s+/).filter(Boolean);
    const permissions = parts[0] ?? "";
    const fileType = permissions[0];
    const sizePart = [...parts].reverse().find((part) => /^\d+$/.test(part));
    const size = sizePart ? Number(sizePart) : 0;
    if (fileType === "d") {
      directories.push(name);
      continue;
    }
    if (fileType !== "-" && fileType !== "l") continue;
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 ? name.slice(dot) : "no ext";
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
    const printableSize = size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)}M` : size >= 1024 ? `${(size / 1024).toFixed(1)}K` : `${size}B`;
    files.push([name, printableSize]);
  }
  if (directories.length === 0 && files.length === 0) return input;

  const rows = [...directories.map((name) => `${name}/`), ...files.map(([name, size]) => `${name}  ${size}`)];
  let summary = `Summary: ${files.length} files, ${directories.length} dirs`;
  const sortedExtensions = [...extensions.entries()].sort(([, left], [, right]) => right - left);
  if (sortedExtensions.length > 0) {
    summary += ` (${sortedExtensions.slice(0, 5).map(([extension, count]) => `${count} ${extension}`).join(", ")}`;
    if (sortedExtensions.length > 5) summary += `, +${sortedExtensions.length - 5} more`;
    summary += ")";
  }
  return `${rows.join("\n")}\n\n${summary}`;
}

function compactGitLog(input: string): string {
  const rows: string[] = [];
  let skipped = 0;
  let inCommit = false;
  let sawSubject = false;
  const push = (line: string) => {
    if (rows.length < GIT_LOG_MAX_LINES) rows.push(line);
    else skipped++;
  };

  for (const raw of input.split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (/^commit [0-9a-f]{7,40}$/i.test(trimmed) || /^[*|/\\ ]+commit [0-9a-f]{7,40}/i.test(trimmed)) {
      inCommit = true;
      sawSubject = false;
      push(line);
      continue;
    }
    if (inCommit) {
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) {
        push(trimmed);
      } else if (!sawSubject && /^[*|/\\ ]*    \S/.test(line)) {
        push(`  Subject: ${trimmed}`);
        sawSubject = true;
      } else if (/^\d+ file\w* changed/.test(trimmed)) {
        push(`  ${trimmed}`);
      } else if (/^diff --git /.test(trimmed)) {
        push("  ... diff body omitted");
      }
      continue;
    }
    const graph = trimmed.match(/^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i);
    if (graph?.[1]) push(graph[1]);
    else if (/^[0-9a-f]{7,40}\s+/.test(trimmed)) push(trimmed);
    else if (!/^[*|/\\ ]+$/.test(trimmed) || !/[*|/\\]/.test(trimmed)) push(trimmed);
  }
  if (skipped > 0) rows.push(`... (${skipped} more lines)`);
  const result = rows.join("\n");
  return !result || result.length > input.length ? input : result;
}


function detectStructuredFilter(text: string): { name: string; filter: TextFilter } | undefined {
  const head = text.slice(0, DETECT_WINDOW);
  if (/^[*|/\\ ]*commit [0-9a-f]{7,40}$/im.test(head)) return { name: "git-log", filter: compactGitLog };
  if (/^diff --git /m.test(head) || /^@@ /m.test(head)) return { name: "git-diff", filter: compactGitDiff };
  if (/^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m.test(head) || /^[ MADRCU?!][ MADRCU?!] \S/m.test(head)) return { name: "git-status", filter: compactGitStatus };
  if (/^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im.test(head)) return { name: "build-output", filter: compactBuildOutput };

  const nonEmpty = head.split("\n").filter((line) => line.trim());
  if (nonEmpty.slice(0, 5).some((line) => /^[^:\n]+:\d+:/.test(line))) return { name: "grep", filter: compactGrep };
  if (nonEmpty.length >= 3 && nonEmpty.every((line) => !line.includes(":") && /[/.\\]|^[\w.-]+$/.test(line.trim()))) return { name: "find", filter: compactPathList };
  if (/[├└]──|│  /.test(head)) return { name: "tree", filter: compactTree };
  if (/^total \d+$/m.test(head) || (head.match(/^[-dlbcps][rwx-]{9}/gm)?.length ?? 0) >= 3) return { name: "ls", filter: compactLs };
  if (/^Result of search in '[^']*' \(total \d+ files?\):/.test(head)) return { name: "search-list", filter: compactPathList };
  return undefined;
}

function compressText(text: string, stats: RtkStats, minChars: number, maxReductionPercent: number): string {
  stats.textBlocksSeen++;
  stats.charactersBefore += text.length;
  if (text.length < minChars || text.length > RAW_CAP) {
    stats.charactersAfter += text.length;
    return text;
  }
  const detected = detectStructuredFilter(text);
  if (!detected) {
    stats.charactersAfter += text.length;
    return text;
  }
  const compressed = safeApply(detected.filter, text);
  const removedPercent = ((text.length - compressed.length) / text.length) * 100;
  if (compressed.length === 0 || compressed.length >= text.length || removedPercent > maxReductionPercent) {
    stats.charactersAfter += text.length;
    return text;
  }
  stats.textBlocksCompressed++;
  stats.charactersAfter += compressed.length;
  stats.filters.push(detected.name);
  return compressed;
}

function compressContentParts(parts: JsonObject[], stats: RtkStats, minChars: number, maxReductionPercent: number): void {
  for (const part of parts) {
    if (!isTextPart(part)) continue;
    const text = stringField(part, "text");
    if (text !== undefined) setField(part, "text", compressText(text, stats, minChars, maxReductionPercent));
  }
}

/**
 * Compresses successful tool-result text in a mutable, provider-shaped
 * request body. Only recognized command-output shapes are candidates; each
 * candidate must stay within the configured quality-loss budget.
 */
export function compressToolResults(body: unknown, minChars: number, maxReductionPercent: number): RtkStats {
  const stats: RtkStats = { textBlocksSeen: 0, textBlocksCompressed: 0, charactersBefore: 0, charactersAfter: 0, filters: [] };
  if (!isObject(body)) return stats;

  const messages = objectArray(field(body, "messages"));
  if (messages) {
    for (const message of messages) {
      const content = field(message, "content");
      if (message.role === "tool") {
        if (typeof content === "string") {
          setField(message, "content", compressText(content, stats, minChars, maxReductionPercent));
        } else {
          const parts = objectArray(content);
          if (parts) compressContentParts(parts, stats, minChars, maxReductionPercent);
        }
        continue;
      }
      const blocks = objectArray(content);
      if (!blocks) continue;
      for (const block of blocks) {
        if (block.type !== "tool_result" || block.is_error === true) continue;
        const result = field(block, "content");
        if (typeof result === "string") {
          setField(block, "content", compressText(result, stats, minChars, maxReductionPercent));
        } else {
          const parts = objectArray(result);
          if (parts) compressContentParts(parts, stats, minChars, maxReductionPercent);
        }
      }
    }
  }

  const input = objectArray(field(body, "input"));
  if (input) {
    for (const item of input) {
      if (item.type !== "function_call_output") continue;
      const output = field(item, "output");
      if (typeof output === "string") {
        setField(item, "output", compressText(output, stats, minChars, maxReductionPercent));
      } else {
        const parts = objectArray(output);
        if (parts) compressContentParts(parts, stats, minChars, maxReductionPercent);
      }
    }
  }
  return stats;
}

function appendOpenAISystemMessage(message: JsonObject, prompt: string): void {
  const content = field(message, "content");
  if (typeof content === "string") {
    setField(message, "content", `${content}\n\n${prompt}`);
    return;
  }
  const parts = objectArray(content);
  if (parts) {
    const hasInputText = parts.some((part) => part.type === "input_text");
    parts.push(hasInputText ? { type: "input_text", text: prompt } : { type: "text", text: prompt });
    return;
  }
  setField(message, "content", prompt);
}

function injectOpenAISystemPrompt(body: JsonObject, prompt: string): void {
  const instructions = stringField(body, "instructions");
  if (instructions !== undefined || Object.hasOwn(body, "instructions")) {
    setField(body, "instructions", instructions ? `${instructions}\n\n${prompt}` : prompt);
    return;
  }
  const messages = objectArray(field(body, "messages"));
  if (!messages) return;
  const existing = messages.find((message) => message.role === "system" || message.role === "developer");
  if (existing) appendOpenAISystemMessage(existing, prompt);
  else messages.unshift({ role: "system", content: prompt });
}

function injectAnthropicSystemPrompt(body: JsonObject, prompt: string): void {
  const system = field(body, "system");
  if (typeof system === "string") {
    setField(body, "system", system ? `${system}\n\n${prompt}` : prompt);
    return;
  }
  const blocks = objectArray(system);
  if (blocks) {
    const lastCacheControl = blocks.findLastIndex((block) => Object.hasOwn(block, "cache_control"));
    const injected = { type: "text", text: prompt };
    if (lastCacheControl === -1) blocks.push(injected);
    else blocks.splice(lastCacheControl, 0, injected);
    return;
  }
  setField(body, "system", prompt);
}

/** Appends the configured server prompt into the format's system-instruction location. */
export function injectSystemPrompt(body: unknown, format: UpstreamFormat, prompt: string): void {
  if (!isObject(body) || prompt.length === 0) return;
  if (format === "anthropic") injectAnthropicSystemPrompt(body, prompt);
  else injectOpenAISystemPrompt(body, prompt);
}

/**
 * Returns an outgoing request ready for upstream dispatch. Disabled transforms
 * return the original object without allocating a clone; enabled transforms
 * operate on a structured clone so route-local request data stays untouched.
 */
export function prepareOutboundRequest(body: unknown, format: UpstreamFormat, settings: RequestTransformSettings): unknown {
  if (!settings.rtk.enabled && settings.systemPrompt === undefined) return body;
  try {
    const transformed = structuredClone(body);
    if (settings.rtk.enabled) {
      compressToolResults(transformed, settings.rtk.minChars, settings.rtk.maxReductionPercent);
    }
    if (settings.systemPrompt !== undefined) injectSystemPrompt(transformed, format, settings.systemPrompt);
    return transformed;
  } catch (error) {
    console.warn("[transforms] could not clone outbound request; forwarding it unchanged", error);
    return body;
  }
}
