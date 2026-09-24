import type { ConsoleAccessResolver } from "../../auth/access";

export interface PerformanceConfig {
  readonly accessResolver: ConsoleAccessResolver;
}
