import periods from "./usage-periods.json";

export type UsagePeriod = (typeof periods)[number];
export const USAGE_PERIODS: readonly UsagePeriod[] = periods;
