/**
 * Instant display, in one place.
 *
 * A chart axis and a chart tooltip are the only two places the dashboard draws
 * a timestamp, and they draw the same instant at two resolutions: the tick is
 * `MM-DD HH:mm`, the tooltip adds the year and the offset because a reader who
 * stops on a point needs to know which day and whose clock. Both go through
 * {@link instantParts} so the fields cannot drift between them.
 *
 * `timeZone` defaults to {@link CHART_TIME_ZONE} rather than to the browser's,
 * so a Usage chart of a tenant whose operators are in one region reads the same
 * to all of them. A caller that genuinely wants the viewer's own clock passes
 * `undefined` explicitly.
 */

function instantParts(
  date: Date,
  locale: string | undefined,
  timeZone: string | undefined,
  named: boolean,
): Record<string, string> {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    hourCycle: "h23",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (named) {
    options.year = "numeric";
    options.timeZoneName = "shortOffset";
  }
  const byType: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat(locale, options).formatToParts(date)) {
    byType[part.type] = part.value;
  }
  return byType;
}

export const CHART_TIME_ZONE = "Asia/Jakarta";

export function formatChartTick(value: string, locale?: string, timeZone: string = CHART_TIME_ZONE): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = instantParts(date, locale, timeZone, false);
  return `${parts.month ?? ""}-${parts.day ?? ""} ${parts.hour ?? ""}:${parts.minute ?? ""}`;
}

export function formatChartTooltip(value: string, locale?: string, timeZone: string = CHART_TIME_ZONE): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = instantParts(date, locale, timeZone, true);
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""} ${parts.hour ?? ""}:${parts.minute ?? ""} ${parts.timeZoneName ?? ""}`;
}
