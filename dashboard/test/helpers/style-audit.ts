/**
 * Source-level styling audit for the dashboard.
 *
 * The styling rebuild's acceptance criteria are structural — no static inline
 * `style`, no arbitrary literal utility, no bespoke per-feature class. None of
 * those is visible to `tsc` or to a render test, so they are measured directly
 * from the sources here, and `style-guard.json` holds the per-file counts the
 * ratchet test enforces.
 *
 * A `style={{…}}` is "static" when every value in the object literal is a
 * literal (a quoted string without template interpolation, or a number). A
 * runtime expression — a spread, a conditional, an identifier, a function call
 * — is legitimate and is not counted: the width of a bar read from state cannot
 * be a utility.
 *
 * An "arbitrary" utility is a bracketed literal value (`gap-[8px]`,
 * `bg-[#fff]`, `shadow-[0_1px_2px_rgba(…)]`) — the values that should be tokens.
 * Structural arbitrary variants (`data-[state=open]`, `[&_svg]:…`) carry no
 * literal and are not counted.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One file's measured styling debt. */
export interface StyleAudit {
  /** Repo-relative, POSIX separators, e.g. `src/features/proxy/ProxyPage.tsx`. */
  readonly file: string;
  /** `style={{…}}` whose every value is a literal — a utility waiting to be written. */
  readonly staticInline: number;
  /** Arbitrary literal utilities such as `gap-[8px]` or `bg-[#fff]`. */
  readonly arbitrary: number;
}

/**
 * A bracketed class value carrying a literal — the clearest token candidates.
 *
 * The shape that counts is `utility-[literal]` at a class boundary, with any
 * leading variants (`hover:`, `max-medium:`, `[&_svg]:`, `min-[640px]:`)
 * attached. A bare structural variant, a bare arbitrary property, and a
 * responsive prefix in front of a *named* utility all carry no value here, so
 * none of them matches — that is what keeps `overflow-wrap:anywhere` and
 * `min-[640px]:inline-flex` out of the count.
 */
const ARBITRARY_LITERAL =
  /(?:^|(?<=[\s"'`]))(?:(?:min|max)-\[[^\]\n]*\]:|[a-z][a-z0-9_-]*:(?=[a-z[])|\[[^\]\n]*\]:)*[a-z][a-z0-9-]*-\[[^\]\n]*[\d#][^\]\n]*\]/g;

/**
 * A breakpoint in front of a *named* utility carries no value: `min-[640px]` is
 * the variant and `grid-cols-2` is the scale. Only the bracket prefix itself
 * matches `ARBITRARY_LITERAL` (as `utility-[literal]`), so those bare
 * `min-[…]`/`max-[…]` matches are dropped here.
 */
const BREAKPOINT_ONLY = /^(?:min|max)-\[[^\]\n]*\]$/;

/**
 * The one other exemption: Tailwind's `flex` shorthand. `flex-[1_1_160px]`
 * spells three longhand `flex-*` utilities in a single bracket (underscores
 * become spaces), so the pixel there is scale input, not an arbitrary value.
 */
const FLEX_SHORTHAND = /flex-\[[^\]\n]*\]/;

/** How many bracketed literals the sources still carry. */
function countArbitraryUtilities(src: string): number {
  let count = 0;
  for (const value of src.match(ARBITRARY_LITERAL) ?? []) {
    if (BREAKPOINT_ONLY.test(value)) continue;
    if (FLEX_SHORTHAND.test(value)) continue;
    count++;
  }
  return count;
}

/** Every `style={ … }` JSX expression's inner text, brace-matched. */
function jsxStyleExpressions(src: string): string[] {
  const found: string[] = [];
  const marker = /style=\{/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(src)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let index = open;
    for (; index < src.length; index++) {
      const char = src[index];
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          index++;
          break;
        }
      }
    }
    found.push(src.slice(open + 1, index - 1));
    marker.lastIndex = index;
  }
  return found;
}

/** Splits an object body on top-level commas, ignoring commas inside quotes and brackets. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of body) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** True when a property value is a literal: a plain quoted string, or a number. */
function isLiteralValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return true;
  if (trimmed.startsWith("`")) return !trimmed.includes("${");
  return /^-?\d+(?:\.\d+)?$/.test(trimmed);
}

/** True when a `style` expression is a plain object literal of literal values. */
function isStaticStyleExpression(expression: string): boolean {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  if (trimmed.includes("...")) return false;
  const body = trimmed.slice(1, -1);
  const properties = splitTopLevel(body);
  if (properties.length === 0) return false;
  for (const property of properties) {
    const colon = property.indexOf(":");
    if (colon === -1) return false;
    if (!isLiteralValue(property.slice(colon + 1))) return false;
  }
  return true;
}

/** Measures one `.tsx` source string. */
export function auditSource(src: string): { staticInline: number; arbitrary: number } {
  let staticInline = 0;
  for (const expression of jsxStyleExpressions(src)) {
    if (isStaticStyleExpression(expression)) staticInline++;
  }
  return { staticInline, arbitrary: countArbitraryUtilities(src) };
}

/** Walks a directory tree and audits every `.tsx` file under it. */
export function auditTree(root: string, prefix: string): StyleAudit[] {
  const audits: StyleAudit[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.name.endsWith(".tsx")) continue;
      const rel = `${prefix}/${full.slice(root.length + 1).split("\\").join("/")}`;
      const { staticInline, arbitrary } = auditSource(readFileSync(full, "utf8"));
      audits.push({ file: rel, staticInline, arbitrary });
    }
  };
  visit(root);
  return audits;
}
