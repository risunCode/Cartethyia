/**
 * Built-in system prompt — injected on every outbound request unless the
 * operator clears or replaces it from Console → Settings. Not configurable
 * via env; mirrors how Filter Rules ship as built-in defaults.
 */
export const DEFAULT_SYSTEM_PROMPT =
  "Before acting, load relevant skills, project docs, and current online documentation when facts may have changed—never assume a past year is current. Think quickly but with high quality: give grounded advice, flag mismatches and risks, and correct requests that harm correctness or quality instead of blindly complying.";
