/**
 * Aggregate line-coverage gate over hand-written backend `src/` (lcov).
 *
 * `COVERAGE_MIN` defaults to `90.0`, the repository's committed floor. It is
 * enforced in both environments: offline the DB-gated console and integration
 * suites skip, but the non-DB surface (protocol codecs, adapters, routing,
 * security) carries the bulk of `src/` and holds the floor on its own. CI runs
 * the same suites with Postgres and Redis attached, so the number there is
 * equal or higher.
 *
 * A caller may override the floor for a deliberate experiment
 * (`COVERAGE_MIN=85 bun run check:coverage`); it is not a way to land a change
 * that drops coverage, because the default is what CI enforces.
 */
import { readFileSync, existsSync } from "node:fs";
import { COVERAGE_LCOV_PATH } from "./ops-env-utils";

const lcovPath = COVERAGE_LCOV_PATH;
if (!existsSync(lcovPath)) {
  console.error(
    "[coverage-gate] coverage/lcov.info not found; run 'bun test --coverage --coverage-reporter=lcov --coverage-dir=coverage' first",
  );
  process.exit(1);
}

const lcov = readFileSync(lcovPath, "utf8");
const records = lcov.split("end_of_record");
let totalLinesFound = 0;
let totalLinesHit = 0;

for (const record of records) {
  const sfMatch = record.match(/^SF:(.+)$/m);
  if (!sfMatch) continue;
  const file = sfMatch[1]!.replace(/\\/g, "/");
  // Gate evaluates hand-written backend src/ only — never dashboard/, generated
  // protobuf, or test files.
  if (
    !file.includes("src/") ||
    file.includes("dashboard/") ||
    file.includes("/generated/") ||
    file.includes(".test.")
  )
    continue;
  const lfMatch = record.match(/^LF:(\d+)$/m);
  const lhMatch = record.match(/^LH:(\d+)$/m);
  if (!lfMatch || !lhMatch) continue;
  totalLinesFound += Number.parseInt(lfMatch[1]!, 10);
  totalLinesHit += Number.parseInt(lhMatch[1]!, 10);
}

const linePct = totalLinesFound === 0 ? 0 : (totalLinesHit / totalLinesFound) * 100;
const minPct = Number.parseFloat(process.env.COVERAGE_MIN ?? "90.0");
console.info(
  `[coverage-gate] src/ line coverage: ${linePct.toFixed(2)}% (${totalLinesHit}/${totalLinesFound} lines, required: ${minPct}%)`,
);

if (linePct < minPct) {
  console.error(
    `[coverage-gate] FAILED: line coverage ${linePct.toFixed(2)}% is below threshold ${minPct}%`,
  );
  process.exit(1);
}
console.info("[coverage-gate] PASSED");
