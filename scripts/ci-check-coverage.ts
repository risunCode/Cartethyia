/**
 * Aggregate line-coverage gate over hand-written backend `src/` (lcov).
 *
 * Offline baseline (no `CARTETHYIA_TEST_DATABASE_URL`) is ~75%: the DB-gated
 * console stores and integration suites are skipped, so `COVERAGE_MIN`
 * defaults to `75.0` to catch regressions from that real floor. In a
 * DB-backed CI environment, pass `COVERAGE_MIN=80.0` to enforce the full
 * target once the skipped suites actually run.
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
const minPct = Number.parseFloat(process.env.COVERAGE_MIN ?? "75.0");
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
