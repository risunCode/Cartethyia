/**
 * UTC calendar boundaries for spend and usage windows.
 *
 * Buckets are cut at UTC midnight and the first of the UTC month, not in the
 * viewer's zone, because the admission counters in `admission.ts` cut theirs
 * from `toISOString().slice(0, 10)` / `slice(0, 7)`. A spend ceiling that reset
 * at a local midnight would not line up with the counter it seeds, and would
 * give a travelling key a short first day and a long last one.
 *
 * Both live here because two domains cut the same windows — API-key bucket
 * spend and share-link usage — and each had grown its own copy.
 */

/** Start of the UTC day containing `now`. */
export function utcDayStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** Start of the UTC month containing `now`. */
export function utcMonthStart(now: Date): Date {
  const start = new Date(now);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}
