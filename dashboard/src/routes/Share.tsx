import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, KeyRound, Link2, RefreshCw, Users } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { useApiKeys, useRevokeSharedKey, useShareApiKey, useSharedKeyActivity, useSharedKeys } from "../lib/hooks/api-keys";
import { copyToClipboard, getErrorMessage } from "../lib/helpers";
import type { SharedKeySummary } from "../lib/contracts";
const count = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const stamp = (s: string | null | undefined) => s ? new Date(s).toLocaleString() : "—";

export function ChildDetail({ parentId, childId }: { parentId: string; childId: string }): ReactNode {
  const detail = useSharedKeyActivity(parentId, childId);
  if (detail.isPending) return <LoadingState label="Loading safe activity…" />;
  if (detail.isError) return <ErrorState message={getErrorMessage(detail.error, "Could not load child activity.")} onRetry={() => void detail.refetch()} />;
  const activity = detail.data;
  return <div className="share-child-detail">
    <section aria-labelledby="share-model-heading">
      <div className="share-detail-heading">
        <div><h3 id="share-model-heading">Top models</h3><p>Today and retained telemetry totals</p></div>
      </div>
      {activity?.models.length ? <div className="share-model-grid">{activity.models.map((model, i) => (
        <article className="share-model-card" key={`${model.providerId ?? ""}-${model.modelId}-${i}`}>
          <h4>{model.modelId}</h4>
          <div className="share-model-periods">
            <div className="share-model-period">
              <h5>Today</h5>
              <dl><div><dt>Hits</dt><dd>{count(model.todayRequests)}</dd></div><div><dt>Errors</dt><dd>{count(model.todayErrors)}</dd></div><div><dt>Tokens</dt><dd>{count(model.todayTokens)}</dd></div></dl>
            </div>
            <div className="share-model-period">
              <h5>Retained telemetry</h5>
              <dl><div><dt>Hits</dt><dd>{count(model.retainedRequests)}</dd></div><div><dt>Errors</dt><dd>{count(model.retainedErrors)}</dd></div><div><dt>Tokens</dt><dd>{count(model.retainedTokens)}</dd></div></dl>
            </div>
          </div>
        </article>
      ))}</div> : <p className="share-detail-empty">No model activity yet.</p>}
    </section>
    <section aria-labelledby="share-requests-heading">
      <div className="share-detail-heading">
        <div><h3 id="share-requests-heading">Recent requests</h3><p>Safe request metadata only — no captured payloads</p></div>
      </div>
      {activity?.requests.length ? <div className="share-event-list">{activity.requests.map((event) => (
        <article className="share-event-card" key={event.requestId}>
          <header>
            <div className="share-event-model">{event.providerId ?? "Provider"} <span aria-hidden="true">/</span> {event.modelId ?? "Model"}</div>
            <span className="share-event-status">{event.status}{event.httpStatus ? ` · HTTP ${event.httpStatus}` : ""}</span>
          </header>
          <dl className="share-event-fields">
            <div><dt>Client IP</dt><dd>{event.clientIp ?? "—"}</dd></div>
            <div className="share-event-error"><dt>Error</dt><dd>{event.errorCategory ?? event.errorOrigin ?? "None"}</dd></div>
            <div><dt>Time</dt><dd>{stamp(event.startedAt)}</dd></div>
            <div><dt>Input tokens</dt><dd>{count(event.inputTokens)}</dd></div>
            <div><dt>Output tokens</dt><dd>{count(event.outputTokens)}</dd></div>
            <div><dt>Total tokens</dt><dd>{count(event.totalTokens)}</dd></div>
          </dl>
        </article>
      ))}</div> : <p className="share-detail-empty">No recent requests.</p>}
    </section>
  </div>;
}

export default function ShareRoute(): ReactNode {
  const keys = useApiKeys();
  const parents = (keys.data ?? []).filter((key) => key.keyMode === "share");
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const share = useShareApiKey();
  const revoke = useRevokeSharedKey();
  const activeParentId = selected ?? parents[0]?.id ?? null;
  const summary = useSharedKeys(activeParentId);
  const children = summary.data ?? [];
  const createLink = (keyId: string) => share.mutate({ keyId }, { onSuccess: (result) => setLink(result.url) });
  return <div style={{ display: "grid", gap: 14 }}>
    <Card><CardHeader title="Shared access" subtitle="Enrollment links and privacy-safe usage from generated child keys" icon={<Users size={16} />} action={<Button variant="secondary" size="sm" onClick={() => void keys.refetch()} icon={<RefreshCw size={13} />}>Refresh</Button>} />
      <CardBody>
        {keys.isPending && !keys.data ? <LoadingState label="Loading share templates…" /> : keys.isError ? <ErrorState message={getErrorMessage(keys.error, "Could not load API keys.")} onRetry={() => void keys.refetch()} /> : parents.length === 0 ? <EmptyState title="No share templates" message="Create an API key in Share template mode to enroll recipients without revealing a parent credential." icon={<KeyRound size={20} />} /> : <div style={{ display: "grid", gap: 8 }}>
          {parents.map((parent) => <div key={parent.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: 12, border: "1px solid var(--inner-border)", borderRadius: 10, background: "var(--surface-2)" }}>
            <div><strong>{parent.label || "Unnamed share template"}</strong><div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Parent ID {parent.id.slice(0, 10)}… · no bearer secret</div></div>
            <div style={{ display: "flex", gap: 8 }}><Button variant="secondary" size="sm" onClick={() => { setSelected(parent.id); setExpanded(null); }}>View recipients</Button><Button variant="primary" size="sm" disabled={share.isPending || Boolean(parent.revokedAt)} onClick={() => createLink(parent.id)} icon={<Link2 size={13} />}>Create enrollment link</Button></div>
          </div>)}
        </div>}
        {share.isError && <p role="alert" style={{ marginTop: 10, color: "var(--red)" }}>{getErrorMessage(share.error, "Could not create enrollment link.")}</p>}
        {link && <div role="status" style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--accent-soft)", background: "var(--accent-soft)" }}><strong style={{ fontSize: 12 }}>Enrollment URL — copy now</strong><code style={{ display: "block", margin: "8px 0", overflowWrap: "anywhere", fontSize: 11 }}>{link}</code><Button variant="secondary" size="sm" icon={<Copy size={13} />} onClick={() => void copyToClipboard(link)}>Copy link</Button><Button variant="secondary" size="sm" onClick={() => window.open(link, "_blank", "noopener")}>Open</Button><Button variant="ghost" size="sm" onClick={() => setLink(null)}>Dismiss</Button></div>}
      </CardBody>
    </Card>
    {activeParentId && <Card><CardHeader title="Recipients" subtitle="Masked identity; live telemetry refreshes every five seconds. Lifetime totals use telemetry available at rollout." icon={<Users size={16} />} /><CardBody>
      {summary.isPending && !summary.data ? <LoadingState label="Loading recipients…" /> : summary.isError ? <ErrorState message={getErrorMessage(summary.error, "Could not load share activity.")} onRetry={() => void summary.refetch()} /> : children.length === 0 ? <EmptyState title="No recipients yet" message="Issued child keys will appear here with masked client IP and aggregate usage." /> : <div style={{ display: "grid", gap: 8 }}>{children.map((child: SharedKeySummary) => <section key={child.id} style={{ border: "1px solid var(--inner-border)", borderRadius: 10, overflow: "hidden" }}>
        <div className="share-recipient-main">
          <div className="share-recipient-identity">
            <div>
              <button type="button" className="share-recipient-key" aria-expanded={expanded === child.id} onClick={() => setExpanded(expanded === child.id ? null : child.id)}>
                {expanded === child.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{child.keyPrefix ?? "key"}…</span>
              </button>
              <div className="share-recipient-context">{child.issuedClientIp ?? "IP hidden"} <span aria-hidden="true">·</span> {child.revokedAt ? "revoked" : "active"}</div>
            </div>
            <Button variant="danger" size="sm" disabled={revoke.isPending || Boolean(child.revokedAt)} onClick={() => revoke.mutate({ parentKeyId: activeParentId, childKeyId: child.id })}>Revoke</Button>
          </div>
          <dl className="share-recipient-metrics">
            <div><dt>Today requests</dt><dd>{count(child.today.requests)}</dd></div>
            <div><dt>Today errors</dt><dd>{count(child.today.errors)}</dd></div>
            <div><dt>Today tokens</dt><dd>{count(child.today.totalTokens)}</dd></div>
            <div title="Earlier events already removed by telemetry retention cannot be reconstructed."><dt>Lifetime requests</dt><dd>{count(child.allTime.requests)}</dd></div>
            <div title="Earlier events already removed by telemetry retention cannot be reconstructed."><dt>Lifetime errors</dt><dd>{count(child.allTime.errors)}</dd></div>
            <div title="Earlier events already removed by telemetry retention cannot be reconstructed."><dt>Lifetime tokens</dt><dd>{count(child.allTime.totalTokens)}</dd></div>
          </dl>
          <p className="share-recipient-dates">Registered {stamp(child.createdAt)} <span aria-hidden="true">·</span> Last activity {stamp(child.lastUsedAt)}</p>
        </div>
        {expanded === child.id && <ChildDetail parentId={activeParentId} childId={child.id} />}
      </section>)}</div>}
    </CardBody></Card>}
  </div>;
}
