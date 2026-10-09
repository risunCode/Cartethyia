/**
 * Generates the environment-variable reference from the config spec.
 *
 * `src/config/spec.ts` is the only hand-written declaration of the knobs
 * `src/config/` reads. An operator-facing list kept by hand next to it would
 * drift the moment a knob was added — which is the failure mode this removes.
 * So the reference is derived: every row of `CONFIG_SPEC` becomes a table row
 * carrying the name, kind, default, and bounds the reader actually enforces.
 *
 * Grouping is taken from the `//`-commented sections already in the spec, so
 * the doc's sections cannot disagree with the spec's own layout. Descriptions
 * are likewise not invented here: a knob gets the prose its group comment
 * already carries, and a knob with none is listed without invented detail.
 *
 * The output is deterministic and checked in; `test/config/config-reference.test.ts`
 * fails when the committed file is stale.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_SPEC } from "../../src/config/spec";

const projectRoot = resolve(import.meta.dir, "..", "..");
const outputPath = resolve(projectRoot, "documentation", "reference", "configuration.md");

type Entry = (typeof CONFIG_SPEC)[keyof typeof CONFIG_SPEC];

/** How each kind reads, in the operator's terms. */
const KIND_LABEL: Record<Entry["kind"], string> = {
  int: "integer",
  text: "string",
  "optional-text": "string, optional",
  "optional-int": "integer, optional",
  required: "string, required",
  flag: "flag",
  list: "comma-separated list",
};

/** Renders the default a knob takes when the variable is unset. */
function defaultValue(entry: Entry): string {
  switch (entry.kind) {
    case "int":
      return String(entry.default);
    case "text":
      return `\`${entry.default}\``;
    case "required":
      return "— (unset throws at startup)";
    case "flag":
      return "enabled (disabled only when literally `false`)";
    case "optional-text":
    case "optional-int":
    case "list":
      return "unset";
  }
}

/** Renders the bounds the reader enforces, or an em dash when there are none. */
function bounds(entry: Entry): string {
  switch (entry.kind) {
    case "int":
      return `${entry.min} – ${entry.max}`;
    case "optional-int":
      return `${entry.min} – ${entry.max} when set`;
    default:
      return "—";
  }
}

/**
 * Section headings, in spec order, with the prose the spec already gives them.
 *
 * Each is matched to the keys that follow its comment in the file, so renaming
 * a knob re-files it automatically and adding a knob with no section lands it
 * under a trailing group rather than silently disappearing.
 */
const SECTIONS: ReadonlyArray<{ readonly title: string; readonly match: RegExp }> = [
  { title: "HTTP listener and dashboard runtime", match: /^PORT$/ },
  {
    title: "Graceful shutdown",
    match: /^CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS$|^CARTETHYIA_DRAIN_TOKEN$/,
  },
  {
    title: "Network policy (trusted proxy and SSRF)",
    match: /^TRUSTED_PROXY_CIDRS$|^CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS$|^CARTETHYIA_ALLOWED_NETWORKS$|^CARTETHYIA_MAX_REDIRECTS$/,
  },
  { title: "Runtime memory", match: /^CARTETHYIA_MEMORY_LIMIT_BYTES$/ },
  { title: "Telemetry", match: /^CARTETHYIA_TELEMETRY_/ },
  {
    title: "Upstream timeouts and retry backoff",
    match: /^CARTETHYIA_UPSTREAM_TIMEOUT_MS$|^CARTETHYIA_STREAM_|^CARTETHYIA_FALLBACK_RETRY_|^CARTETHYIA_ROUTE_MAX_ATTEMPTS$/,
  },
  { title: "Account and pool cooldowns", match: /^CARTETHYIA_ACCOUNT_|^CARTETHYIA_POOL_COOLDOWN_MS$/ },
  { title: "Proxy pool agents", match: /^CARTETHYIA_PROXY_/ },
  {
    title: "Security, abuse ceiling, and secrets",
    match: /^IP_RATE_MAX_PER_WINDOW$|^CARTETHYIA_MODEL_|^CARTETHYIA_ENCRYPTION_KEY$|^CARTETHYIA_PUBLIC_ORIGIN$/,
  },
  { title: "Provider OAuth hosts", match: /^CARTETHYIA_KIMI_|^CARTETHYIA_GITHUB_/ },
];

/**
 * Every spec key, in declaration order.
 *
 * Object key order is insertion order, so this is the spec's own layout — no
 * source parsing, and therefore nothing to break when the file is reflowed or
 * a comment is added.
 */
function specRows(): SpecRow[] {
  return Object.entries(CONFIG_SPEC).map(([key, entry]) => ({ key, entry }));
}

/** A spec row paired with the name it is declared under. */
interface SpecRow {
  readonly key: string;
  readonly entry: Entry;
}

/**
 * Files every row into its section, in declaration order.
 *
 * Grouping carries the entry along rather than re-looking it up by key, so
 * there is no indexing to be undefined under `noUncheckedIndexedAccess`.
 */
function group(rows: readonly SpecRow[]): Array<{ title: string; rows: SpecRow[] }> {
  const filed = SECTIONS.map((section) => ({
    title: section.title,
    rows: rows.filter((row) => section.match.test(row.key)),
  }));
  const other = rows.filter((row) => !SECTIONS.some((section) => section.match.test(row.key)));
  if (other.length > 0) filed.push({ title: "Other", rows: other });
  return filed.filter((section) => section.rows.length > 0);
}

export function renderConfigReference(): string {
  const rows = specRows();
  const sections = group(rows);
  const out: string[] = [
    "# Configuration",
    "",
    "Generated by `scripts/generate/config-reference.ts` from `src/config/spec.ts`.",
    "Do not edit by hand: change the spec, then re-run",
    "`bun scripts/generate/config-reference.ts`.",
    "",
    "`CONFIG_SPEC` is the single declaration of every environment variable",
    "`src/config/` reads. Bounds are enforced on read, so a malformed value",
    "throws at the boundary instead of being coerced. Adding a knob means adding",
    "a row there plus a `.env.example` line.",
    "",
    "Two variables are read outside the spec and are therefore **not** listed",
    "below: `CARTETHYIA_DB_MODE` (lite/full, read by the setup and boot path) and",
    "`DATABASE_URL` (full mode only). See `documentation/getting-started.md`.",
    "",
  ];

  for (const section of sections) {
    out.push(`## ${section.title}`, "");
    out.push("| Variable | Kind | Default | Bounds |", "| --- | --- | --- | --- |");
    for (const { key, entry } of section.rows) {
      out.push(`| \`${key}\` | ${KIND_LABEL[entry.kind]} | ${defaultValue(entry)} | ${bounds(entry)} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

if (import.meta.main) {
  writeFileSync(outputPath, renderConfigReference(), "utf8");
  console.log(`Wrote ${outputPath}`);
}
