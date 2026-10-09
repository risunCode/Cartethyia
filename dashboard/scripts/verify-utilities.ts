/**
 * Verifies that every Tailwind utility emitted by the converted `ui/`
 * primitives actually resolves to a rule in the built CSS.
 *
 * A utility that does not resolve is invisible: no typecheck, no test, and no
 * build error catches it — the component just renders unstyled. This scans the
 * primitive sources for class strings, extracts candidate utilities, and greps
 * the built stylesheet for each generated selector.
 *
 * Run after `bun run build`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ASSETS = "../dist/dashboard/assets";
const PRIMITIVES = "src/components/ui";

function builtCss(): string {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith(".css"));
  return files.map((f) => readFileSync(join(ASSETS, f), "utf8")).join("\n");
}

/** Marker classes are DOM hooks, not utilities; they need no CSS rule. */
const MARKERS: Record<string, true> = {
  "card-solid": true, "card-glass": true, "card-muted": true,
  "card-elevation-none": true, "card-elevation-card": true, "card-elevation-popout": true,
  "card-header-bar": true, "card-header-left": true, "card-header-leading": true,
  "card-header-icon": true, "card-header-titles": true, "card-header-title": true,
  "card-header-subtitle-row": true, "card-header-subtitle": true,
  "card-header-action": true, "card-body-content": true,
  btn: true, "btn-primary": true, "btn-secondary": true, "btn-ghost": true,
  "btn-danger": true, "btn-sm": true, "btn-icon": true, "btn-labeled": true,
  "btn-label": true, "btn-icon-wrapper": true,
  badge: true, "badge-default": true, "badge-ok": true, "badge-err": true,
  "badge-warn": true, "badge-info": true, "badge-accent": true,
  "badge-active": true, "badge-disabled": true,
  "list-row": true, "list-row-body": true, "list-row-leading": true,
  "list-row-actions": true, "list-row-compact": true,
  "code-chip-plain": true, "code-chip-muted": true, "code-chip-accent": true,
  "code-chip-action": true,
  "state-viewport": true, "state-viewport-compact": true, "state-box": true,
  "state-box-icon": true, "state-box-icon-danger": true, "state-box-label": true,
};
/** Escapes a utility the way Tailwind escapes it in a selector. */
function selectorOf(utility: string): string {
  return "." + utility.replace(/[.[\]()%#,:/&]/g, (c) => "\\" + c);
}

/** Strips a variant prefix (`hover:`, `@container/x:`) to get the base utility. */
function baseOf(utility: string): string {
  const i = utility.lastIndexOf(":");
  return i === -1 ? utility : utility.slice(i + 1);
}

const css = builtCss();
const files = readdirSync(PRIMITIVES).filter((f) => f.endsWith(".tsx"));
const missing: string[] = [];
let checked = 0;

for (const file of files) {
  const src = readFileSync(join(PRIMITIVES, file), "utf8");
  for (const match of src.matchAll(/"([^"\n]*?)"/g)) {
    const raw = match[1];
    // Only class strings. Import paths, `var(--x)`, and bare CSS keyword
    // values (`space-between`) are not utilities.
    if (/^[.@a-z-]*\//.test(raw) || raw.includes("var(")) continue;
    if (/^[a-z-]+$/.test(raw)) continue; // bare identifier, not a class list
    if (!/[-:[]/.test(raw)) continue;
    for (const token of raw.split(/\s+/)) {
      if (token.length === 0) continue;
      const base = baseOf(token);
      if (MARKERS[base] === true || MARKERS[token] === true) continue;
      // Skip things that are plainly not utilities.
      if (!/^[a-z@[]/.test(token)) continue;
      checked++;
      const sel = selectorOf(token);
      if (!css.includes(sel)) missing.push(`${file}: ${token}`);
    }
  }
}

console.log(`checked ${checked} utility candidates across ${files.length} primitives`);
if (missing.length > 0) {
  console.log(`\n${missing.length} UNRESOLVED:`);
  for (const m of missing) console.log("  " + m);
  process.exit(1);
}
console.log("all resolved");
