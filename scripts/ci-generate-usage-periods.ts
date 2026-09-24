/// <reference types="bun-types" />
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { USAGE_PERIODS } from "../src/console/domains/stats/usage-periods";

const projectRoot = resolve(import.meta.dir, "..");
const outPath = resolve(projectRoot, "dashboard/src/lib/generated/usage-periods.json");

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify([...USAGE_PERIODS], null, 2)}\n`);
