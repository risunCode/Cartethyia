import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import {
  authCredential,
  getJson,
  percentWindow,
  quotaRecord,
  record,
  text,
  number,
  isoDate,
} from "../../quota/quota-contracts";
import { getAntigravityUserAgent, getAntigravityVersion, collapseAntigravityVariant, loadAntigravityProject } from "./antigravity-protocol";
import { ANTIGRAVITY_MODELS } from "./antigravity";
import { log } from "../../../observability/logger";

interface AntigravityQuotaFamily {
  readonly key: string;
  readonly label: string;
}

/**
 * Catalog model ids whose quota the console reports.
 *
 * The upstream `fetchAvailableModels` payload carries every deployment the
 * account can reach — internal ones, and one entry per effort tier
 * (`gemini-3.8-flash-low`/`-medium`/`-high`), which are a single model to the
 * operator. Each upstream key is collapsed with
 * {@link collapseAntigravityVariant} and kept only when the catalog serves the
 * resulting id, so a quota row exists for exactly the models the operator can
 * select.
 *
 * This replaced a hand-kept list plus a permissive id pattern, which let a
 * deployment the catalog no longer serves (`gemini-2.5-pro`) report a quota row
 * for a model that cannot be chosen. Deriving the set means removing a catalog
 * model removes its quota row in the same change.
 */
const CATALOG_MODEL_IDS: ReadonlySet<string> = new Set(
  ANTIGRAVITY_MODELS.filter((model) => model.serviceKind !== "websearch").map((model) => model.modelId),
);

function modelFamily(modelId: string): AntigravityQuotaFamily {
  if (/^(?:gemini[-_]|tab_)/i.test(modelId)) return { key: "google", label: "Google" };
  return { key: "claude", label: "Claude" };
}

/** Display names for the two per-model families, as the operator reads them. */
const FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  google: "Gemini (Flash / Pro)",
  claude: "Claude (Sonnet / Opus)",
});

/**
 * Display names for the summary groups, matched by the upstream's own group
 * display name. The upstream groups buckets by family rather than by model, so
 * the label names both families that share the window — a row labelled only
 * "Claude" would hide that GPT-OSS draws on the same allowance.
 */
const SUMMARY_FAMILIES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /gemini/i, label: "Gemini" },
  { pattern: /claude|gpt/i, label: "Claude & GPT" },
];

/**
 * The window kinds the summary reports. A free-tier account's only quota lives
 * here, and a paid account carries more than one: a rolling 5-hour session, a
 * daily allowance, and a weekly allowance. They are independent budgets, so
 * collapsing daily into the 5-hour row hid the daily number entirely.
 */
type SummaryWindowKind = "session" | "daily" | "weekly";

const SUMMARY_WINDOW_LABELS: Readonly<Record<SummaryWindowKind, string>> = Object.freeze({
  session: "5 Hour",
  daily: "Daily",
  weekly: "Weekly",
});

/**
 * Classifies a summary bucket.
 *
 * The upstream names the window in `window` (`5h`, `daily`, `weekly`) and
 * repeats it in the display name. Daily must be tested before the 5-hour
 * session: an older spelling put `daily` on the session bucket, but a bucket
 * whose own text says "daily" is the daily allowance, and treating it as the
 * session is what dropped the daily row.
 */
function summaryWindowKind(bucket: Record<string, unknown>): SummaryWindowKind | undefined {
  const source = `${text(bucket.window) ?? ""} ${text(bucket.bucketId) ?? ""} ${text(bucket.displayName) ?? ""}`.toLowerCase();
  if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) return "weekly";
  if (source.includes("5h") || source.includes("five hour") || /5[\s_-]*hour/.test(source)) return "session";
  if (source.includes("daily") || source.includes("24h") || /\bday/.test(source)) return "daily";
  return undefined;
}

function isQuotaModel(modelId: string): boolean {
  return CATALOG_MODEL_IDS.has(collapseAntigravityVariant(modelId));
}

/**
 * Keeps the row whose remaining allowance is lowest.
 *
 * The upstream reports one quota per deployment, and several deployments are
 * tier variants of one catalog model (`gemini-3.8-flash-high`/`-medium`/`-low`).
 * The family row must reflect the *worst* variant, because that is the one the
 * operator will actually run out of; averaging them, or showing the first, hid
 * an exhausted tier behind a healthy sibling.
 */
function keepWorse(
  current: ProviderQuotaWindow | undefined,
  candidate: ProviderQuotaWindow,
): ProviderQuotaWindow {
  if (current === undefined) return candidate;
  const currentRemaining = current.remainingPercent;
  const candidateRemaining = candidate.remainingPercent;
  if (currentRemaining === null) return candidate;
  if (candidateRemaining === null) return current;
  return candidateRemaining < currentRemaining ? candidate : current;
}

/** Total the upstream's fractional allowance is normalized against. */
const QUOTA_TOTAL = 1000;

/** Builds a window from a `remainingFraction` + `resetTime` pair. */
function fractionWindow(
  kind: string,
  label: string,
  remainingFraction: number,
  resetsAt: string | null,
): ProviderQuotaWindow {
  const fraction = Math.min(1, Math.max(0, remainingFraction));
  const used = QUOTA_TOTAL - Math.round(QUOTA_TOTAL * fraction);
  return {
    ...percentWindow(kind, label, (1 - fraction) * 100, resetsAt, used, QUOTA_TOTAL, "independent"),
    recurring: true,
  };
}

/**
 * Every quota window one model entry carries.
 *
 * The catalog endpoint reports more than `quotaInfo`. A paid account adds
 * `dailyQuotaInfo` and `weeklyQuotaInfo`, and some payloads key the windows by
 * name under `quotaInfoByWindow`. Reading only `quotaInfo` is why the daily and
 * weekly rows never appeared beside the per-model fraction.
 */
function modelQuotaEntries(model: Record<string, unknown>): readonly { readonly info: Record<string, unknown>; readonly kind: SummaryWindowKind | undefined }[] {
  const entries: { info: Record<string, unknown>; kind: SummaryWindowKind | undefined }[] = [];
  const add = (value: unknown, kind: SummaryWindowKind | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) add(item, kind);
      return;
    }
    const info = record(value);
    if (info !== null) entries.push({ info, kind });
  };
  add(model.quotaInfo, undefined);
  add(model.quotaInfos, undefined);
  add(model.dailyQuotaInfo, "daily");
  add(model.dailyQuotaInfos, "daily");
  add(model.weeklyQuotaInfo, "weekly");
  add(model.weeklyQuotaInfos, "weekly");
  const byWindow = record(model.quotaInfoByWindow) ?? record(model.quotaInfosByWindow);
  if (byWindow !== null) {
    for (const [windowId, value] of Object.entries(byWindow)) add(value, summaryWindowKind({ window: windowId }));
  }
  return entries;
}

/**
 * Per-model quotas from `v1internal:fetchAvailableModels`.
 *
 * Collapses tier variants to one row per catalog family: the upstream lists
 * `gemini-3.8-flash-low`, `…-medium`, and `…-high` as three deployments, and
 * three rows for one model is noise. Each key is collapsed to its catalog id,
 * kept only when the catalog serves it, and the worst variant in a family
 * becomes that family's row. A family that reports more than one window keeps
 * one row per window, so the daily allowance is not overwritten by the weekly.
 */
function parseModelQuotas(payload: Record<string, unknown>): ProviderQuotaWindow[] {
  const models = record(payload.models) ?? record(payload.modelQuotas) ?? record(payload.quota);
  if (models === null) return [];
  const grouped = new Map<string, ProviderQuotaWindow>();
  for (const [modelId, raw] of Object.entries(models)) {
    const model = record(raw);
    if (!model || model.isInternal === true || !isQuotaModel(modelId)) continue;
    const family = modelFamily(collapseAntigravityVariant(modelId));
    const familyLabel = FAMILY_LABELS[family.key] ?? family.label;
    for (const entry of modelQuotaEntries(model)) {
      const fraction = number(entry.info.remainingFraction);
      if (fraction === null) continue;
      const kind = entry.kind ?? summaryWindowKind(entry.info);
      const label = kind === undefined ? familyLabel : `${familyLabel} (${SUMMARY_WINDOW_LABELS[kind]})`;
      const key = `${family.key}:${kind ?? "model"}`;
      const window = fractionWindow(key, label, fraction, isoDate(entry.info.resetTime));
      grouped.set(key, keepWorse(grouped.get(key), window));
    }
  }
  return [...grouped.values()];
}

/**
 * Session, daily, and weekly quotas from `v1internal:retrieveUserQuotaSummary`.
 *
 * This is the only quota a free-tier account has: the upstream omits per-model
 * quota for it, so a parser that reads only `models` reports no windows at all
 * on a free account. The groups are matched to a family by display name, and
 * each group carries its own windows. A bucket the upstream did not name is
 * kept rather than dropped — two unnamed buckets in one group are the daily
 * and weekly allowances, told apart by which resets later.
 *
 * A disabled session bucket is kept at 0% rather than dropped: the operator
 * needs to see that the 5-hour lane is blocked. A disabled weekly bucket is
 * genuinely gone and is skipped.
 */
function parseSummaryQuotas(payload: Record<string, unknown>): ProviderQuotaWindow[] {
  const summary = record(payload.quotaSummary) ?? payload;
  const groups = Array.isArray(summary.groups) ? summary.groups : [];
  const found = new Map<string, ProviderQuotaWindow>();
  const addBucket = (bucket: Record<string, unknown>, familyLabel: string, kind: SummaryWindowKind): void => {
    if (bucket.disabled === true && kind === "weekly") return;
    const fraction = bucket.disabled === true ? 0 : number(bucket.remainingFraction);
    if (fraction === null) return;
    const key = `${familyLabel}:${kind}`;
    if (found.has(key)) return;
    found.set(key, fractionWindow(`${kind}:${familyLabel}`, `${familyLabel} (${SUMMARY_WINDOW_LABELS[kind]})`, fraction, isoDate(bucket.resetTime)));
  };
  for (const rawGroup of groups) {
    const group = record(rawGroup);
    if (!group) continue;
    const groupName = text(group.displayName) ?? "";
    const family = SUMMARY_FAMILIES.find((candidate) => candidate.pattern.test(groupName));
    if (family === undefined) continue;
    const buckets = (Array.isArray(group.buckets) ? group.buckets : []).flatMap((item) => {
      const bucket = record(item);
      return bucket === null ? [] : [bucket];
    });
    const unnamed = buckets.filter((bucket) => summaryWindowKind(bucket) === undefined && bucket.disabled !== true);
    const unnamedKind = new Map<Record<string, unknown>, SummaryWindowKind>();
    if (unnamed.length > 0) {
      const latest = unnamed.reduce((best, bucket) => {
        const at = isoDate(bucket.resetTime);
        const bestAt = isoDate(best.resetTime);
        return at !== null && (bestAt === null || at > bestAt) ? bucket : best;
      });
      for (const bucket of unnamed) unnamedKind.set(bucket, bucket === latest && unnamed.length > 1 ? "weekly" : "daily");
    }
    for (const bucket of buckets) {
      const kind = summaryWindowKind(bucket) ?? unnamedKind.get(bucket);
      if (kind !== undefined) addBucket(bucket, family.label, kind);
    }
  }
  return [...found.values()];
}

export async function fetchAntigravityQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(fields.accessToken) ?? credential;
  const headers = {
    authorization: `Bearer ${access}`,
    "content-type": "application/json",
    // Discovered client UA, never a stale pinned version. The `x-client-*`
    // pair is what the desktop client sends alongside it, and
    // `retrieveUserQuotaSummary` answers 403 without them (verified: the same
    // token that reaches `fetchAvailableModels` is refused on the summary
    // endpoint when the pair is missing).
    "user-agent": getAntigravityUserAgent(),
    "x-client-name": "antigravity",
    "x-client-version": getAntigravityVersion(),
  };
  const project =
    fields.projectId ?? fields.providerAccountId ?? (await loadAntigravityProject(access, { fetcher }));
  const hosts = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
  ];
  // Both endpoints are read and merged, because each carries a quota the other
  // does not: `fetchAvailableModels` has the per-model windows, and
  // `retrieveUserQuotaSummary` has the weekly ones — the only windows a
  // free-tier account has at all. Either may fail without failing the other,
  // and a result with neither is the caller's error to report.
  const windows: ProviderQuotaWindow[] = [];
  let plan: string | null = null;
  for (const host of hosts) {
    try {
      const summary = quotaRecord(
        await getJson(`${host}/v1internal:retrieveUserQuotaSummary`, headers, fetcher, {
          ...(project === undefined ? {} : { project }),
        }),
      );
      windows.push(...parseSummaryQuotas(summary));
      plan = plan ?? text(summary.tier) ?? text(summary.plan);
      if (windows.length > 0) break;
    } catch (error) {
      // The summary endpoint can be unreachable or refuse the token; the
      // per-model endpoint below still answers, so this is a downgrade, not a
      // failure. Logged so a summary that never lands is visible.
      log.warn("antigravity: quota summary fetch failed", { error: String(error) });
    }
  }
  for (const host of hosts) {
    try {
      const models = quotaRecord(
        await getJson(`${host}/v1internal:fetchAvailableModels`, headers, fetcher, {
          ...(project === undefined ? {} : { project }),
        }),
      );
      windows.push(...parseModelQuotas(models));
      plan = plan ?? text(models.tier) ?? text(models.plan);
      break;
    } catch {
      // Fall through to the next host.
    }
  }
  return {
    source: "antigravity",
    plan: plan ?? "Antigravity",
    windows,
    error: null,
  };
}
