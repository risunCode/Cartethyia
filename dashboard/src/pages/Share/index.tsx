
import { Show, createMemo, createResource, type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { Card, CardHeader } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/badge";
import { ShareStatus, type ShareStatusSnapshot } from "../../components/shared/ShareStatus";
import { formatRelativeTime, formatTime } from "../../lib/format";
import { consoleFailure } from "../../lib/console-api";

/**
 * Field map of the API's public share monitor payload
 * (`GET /share/<token>/data`, see the API's share handler).
 * The page is credential-free by contract — no console session is used.
 */
interface ShareMonitorResponse {
  readonly name?: string;
  readonly active?: boolean;
  readonly apiKey?: { readonly id?: string; readonly prefix?: string };
  readonly quotaAvailable?: boolean;
  readonly inFlight?: number;
  readonly totalTokens?: number;
  readonly totalRequests?: number;
  readonly dailyUsed?: number;
  readonly dailyLimit?: number | null;
  readonly monthlyUsed?: number;
  readonly monthlyLimit?: number | null;
  readonly rateLimitRpm?: number | null;
  readonly maxConcurrentRequests?: number | null;
  readonly createdAt?: string;
  readonly lastUsedAt?: string | null;
  readonly baseUrl?: string;
}

interface ShareDetails {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
  readonly quotaAvailable: boolean;
  readonly inFlight: number;
  readonly totalTokens: number;
  readonly totalRequests: number;
  readonly dailyUsed: number;
  readonly dailyLimit: number | null;
  readonly monthlyUsed: number;
  readonly monthlyLimit: number | null;
  readonly rateLimitRpm: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly baseUrl: string;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function fetchShareDetails(shareId: string): Promise<ShareDetails | null> {
  const url = `/share/${encodeURIComponent(shareId)}/data`;
  return fetch(url, { credentials: "omit", headers: { Accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) return null;
      const raw = (await response.json()) as ShareMonitorResponse;
      return {
        id: readString(raw.apiKey?.id) ?? shareId,
        label: readString(raw.name) ?? "Shared link",
        active: raw.active !== false,
        quotaAvailable: raw.quotaAvailable !== false,
        inFlight: readNumber(raw.inFlight) ?? 0,
        totalTokens: readNumber(raw.totalTokens) ?? 0,
        totalRequests: readNumber(raw.totalRequests) ?? 0,
        dailyUsed: readNumber(raw.dailyUsed) ?? 0,
        dailyLimit: readNumber(raw.dailyLimit),
        monthlyUsed: readNumber(raw.monthlyUsed) ?? 0,
        monthlyLimit: readNumber(raw.monthlyLimit),
        rateLimitRpm: readNumber(raw.rateLimitRpm),
        maxConcurrentRequests: readNumber(raw.maxConcurrentRequests),
        createdAt: readString(raw.createdAt) ?? new Date().toISOString(),
        lastUsedAt: readString(raw.lastUsedAt),
        baseUrl: readString(raw.baseUrl) ?? "",
      } satisfies ShareDetails;
    })
    .catch(() => null);
}

export default function Share(): JSX.Element {
  const params = useParams<{ shareId: string }>();
  const shareId = (): string => params.shareId ?? "";

  const [detailsResource] = createResource<ShareDetails | null, string>(shareId, (id) => fetchShareDetails(id));

  const statusStreamUrl = createMemo(() => `/share/${encodeURIComponent(shareId())}/stream`);

  const initialSnapshot = createMemo<ShareStatusSnapshot | null>(() => {
    const details = detailsResource();
    if (!details) return null;
    return {
      id: details.id,
      label: details.label,
      tone: details.quotaAvailable ? "active" : "exhausted",
      progress: details.dailyUsed,
      progressMax:
        details.dailyLimit !== null && details.dailyLimit > 0
          ? details.dailyLimit
          : details.monthlyLimit !== null && details.monthlyLimit > 0
          ? details.monthlyLimit
          : 100,
      totalTokens: details.totalTokens,
      totalRequests: details.totalRequests,
      createdAt: details.createdAt,
      lastUsedAt: details.lastUsedAt,
      expiresAt: null,
      inFlight: details.inFlight,
    };
  });

  const failure = createMemo(() => consoleFailure(detailsResource.error));

  return (
    <div class="space-y-6">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div class="min-w-0">
          <h1 class="truncate text-2xl font-bold text-[var(--text-1)]">Share monitor</h1>
          <p class="mt-1 truncate font-mono text-[12px] text-[var(--text-3)]">
            {shareId() ? `share_id = ${shareId()}` : "share_id missing"}
          </p>
        </div>
        <Show when={failure()}>
          {(status) => <Badge tone="danger">{status().message}</Badge>}
        </Show>
      </header>

      <Show
        when={detailsResource()}
        fallback={
          <Show when={!detailsResource.loading} fallback={<Skeleton className="h-48" />}>
            <Card density="comfortable">
              <CardHeader title="Share unavailable" sub="The link could not be loaded" />
              <p class="text-[12px] text-[var(--text-3)]">
                Verify the share link is correct, still active, and not expired.
              </p>
            </Card>
          </Show>
        }
      >
        {(details) => (
          <>
            <ShareStatus
              url={statusStreamUrl()}
              snapshot={initialSnapshot() ?? undefined}
              events={["count"]}
              fallbackMessage="Awaiting first status update…"
            />
            <Card density="comfortable" className="share-fade-in">
              <CardHeader title="Metadata" sub="Static share configuration" />
              <dl class="grid gap-3 text-[12px] sm:grid-cols-2">
                <Detail label="Created" value={formatTime(details().createdAt)} />
                <Detail label="Last used" value={formatNullableRelative(details().lastUsedAt)} />
                <Detail
                  label="Daily usage"
                  value={`${details().dailyUsed.toLocaleString("en-US")} / ${formatNullableCount(details().dailyLimit)}`}
                />
                <Detail
                  label="Monthly usage"
                  value={`${details().monthlyUsed.toLocaleString("en-US")} / ${formatNullableCount(details().monthlyLimit)}`}
                />
                <Detail label="Rate limit (rpm)" value={formatNullableCount(details().rateLimitRpm)} />
                <Detail label="Max concurrent" value={formatNullableCount(details().maxConcurrentRequests)} />
                <Detail label="Base URL" value={details().baseUrl || "—"} />
              </dl>
              <Show when={details().baseUrl}>
                <div class="mt-4 flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigator.clipboard?.writeText(details().baseUrl).catch(() => undefined)}
                  >
                    Copy base URL
                  </Button>
                </div>
              </Show>
            </Card>
          </>
        )}
      </Show>
    </div>
  );
}

function formatNullableRelative(value: string | null): string {
  return value ? formatRelativeTime(value) : "—";
}

function formatNullableCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function Detail(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="min-w-0">
      <dt class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">{props.label}</dt>
      <dd class="mt-0.5 break-words text-[var(--text-1)]">{props.value}</dd>
    </div>
  );
}
