import type { UsagePeriod as BackendUsagePeriod } from "../../../src/console/domains/stats/usage-periods";
import generated from "./generated/usage-periods.json";

export const USAGE_PERIODS: readonly BackendUsagePeriod[] = generated as readonly BackendUsagePeriod[];
export type UsagePeriod = BackendUsagePeriod;
