import { ChevronDown, ChevronRight, Link2, RefreshCw, Users } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ClipboardButton } from "./patterns/clipboard-button";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import type { ApiKeyResponse, SharedKeyActivityDetail, SharedKeySummary } from "../lib/contracts";
import {
  useRevokeSharedKey,
  useShareApiKey,
  useSharedKeyActivity,
  useSharedKeys,
} from "../lib/hooks/api-keys";

const count = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const stamp = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—");

export function ChildDetail({ parentId, childId }: { parentId: string; childId: string }): ReactNode {
  const detail = useSharedKeyActivity(parentId, childId);
  if (detail.isPending) return <LoadingState label="Loading safe activity…" />;
  if (detail.isError) {
    return (
      <ErrorState
        message={getErrorMessage(detail.error, "Could not load child activity.")}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const activity: SharedKeyActivityDetail | undefined = detail.data;
  return (
    <div className="share-child-detail">
      <section aria-labelledby="share-model-heading">
        <div className="share-detail-heading">
          <div>
            <h3 id="share-model-heading">Top models</h3>
            <p>Today and retained telemetry totals</p>
          </div>
        </div>
        {activity?.models.length ? (
          <div className="share-model-grid">
            {activity.models.map((model, i) => (
              <article
                className="share-model-card"
                key={`${model.providerId ?? ""}-${model.modelId}-${i}`}
              >
                <h4>{model.modelId}</h4>
                <div className="share-model-periods">
                  <div className="share-model-period">
                    <h5>Today</h5>
                    <dl>
                      <div>
                        <dt>Hits</dt>
                        <dd>{count(model.todayRequests)}</dd>
                      </div>
                      <div>
                        <dt>Errors</dt>
                        <dd>{count(model.todayErrors)}</dd>
                      </div>
                      <div>
                        <dt>Tokens</dt>
                        <dd>{count(model.todayTokens)}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="share-model-period">
                    <h5>Retained telemetry</h5>
                    <dl>
                      <div>
                        <dt>Hits</dt>
                        <dd>{count(model.retainedRequests)}</dd>
                      </div>
                      <div>
                        <dt>Errors</dt>
                        <dd>{count(model.retainedErrors)}</dd>
                      </div>
                      <div>
                        <dt>Tokens</dt>
                        <dd>{count(model.retainedTokens)}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="share-detail-empty">No model activity yet.</p>
        )}
      </section>
      <section aria-labelledby="share-requests-heading">
        <div className="share-detail-heading">
          <div>
            <h3 id="share-requests-heading">Recent requests</h3>
            <p>Safe request metadata only — no captured payloads</p>
          </div>
        </div>
        {activity?.requests.length ? (
          <div className="share-event-list">
            {activity.requests.map((event) => (
              <article className="share-event-card" key={event.requestId}>
                <header>
                  <div className="share-event-model">
                    {event.providerId ?? "Provider"} <span aria-hidden="true">/</span>{" "}
                    {event.modelId ?? "Model"}
                  </div>
                  <span className="share-event-status">
                    {event.status}
                    {event.httpStatus ? ` · HTTP ${event.httpStatus}` : ""}
                  </span>
                </header>
                <dl className="share-event-fields">
                  <div>
                    <dt>Client IP</dt>
                    <dd>{event.clientIp ?? "—"}</dd>
                  </div>
                  <div className="share-event-error">
                    <dt>Error</dt>
                    <dd>{event.errorCategory ?? event.errorOrigin ?? "None"}</dd>
                  </div>
                  <div>
                    <dt>Time</dt>
                    <dd>{stamp(event.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>Input tokens</dt>
                    <dd>{count(event.inputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Output tokens</dt>
                    <dd>{count(event.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Total tokens</dt>
                    <dd>{count(event.totalTokens)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <p className="share-detail-empty">No recent requests.</p>
        )}
      </section>
    </div>
  );
}

export function ShareManagementDialog({
  parent,
  onClose,
}: {
  parent: ApiKeyResponse;
  onClose: () => void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("");
  const share = useShareApiKey();
  const revoke = useRevokeSharedKey();
  const summary = useSharedKeys(parent.id);
  const children = summary.data ?? [];

  useEffect(() => {
    setQuery("");
    setExpanded(null);
    setLink(null);
    setExpiry("");
  }, [parent.id]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? children.filter((child: SharedKeySummary) =>
        `${child.keyPrefix ?? ""} ${child.issuedClientIp ?? ""} ${child.id}`.toLowerCase().includes(normalizedQuery),
      )
    : children;

  const createLink = () => {
    setLink(null);
    let expiresAt: string | undefined;
    if (expiry) {
      const parsed = new Date(expiry);
      if (Number.isNaN(parsed.getTime())) {
        toast.error("Enter a valid expiry date or leave it empty.");
        return;
      }
      expiresAt = parsed.toISOString();
    }
    share.mutate(
      { keyId: parent.id, expiresAt },
      {
        onSuccess: (result) => setLink(result.url),
        onError: (error) => toast.error(getErrorMessage(error, "Could not create share link.")),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Share management — ${parent.label || "share template"}`}
      description="Create enrollment links and inspect or revoke issued child credentials."
      width={760}
    >
      <div style={{ display: "grid", gap: 14 }}>
        <section aria-label="Enrollment link" style={{ display: "grid", gap: 8 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "end",
              justifyContent: "space-between",
            }}
          >
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <Input
                label="Expires"
                hint="optional"
                type="datetime-local"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={createLink}
              disabled={share.isPending || Boolean(parent.revokedAt)}
              icon={<Link2 size={13} />}
            >
              {share.isPending ? "Creating…" : "Create enrollment link"}
            </Button>
          </div>
          {link ? (
            <div
              role="status"
              style={{
                padding: 12,
                borderRadius: 10,
                border: "1px solid var(--accent-soft)",
                background: "var(--accent-soft)",
                display: "grid",
                gap: 8,
              }}
            >
              <strong style={{ fontSize: 12 }}>Enrollment URL — copy now</strong>
              <code style={{ overflowWrap: "anywhere", fontSize: 11 }}>{link}</code>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <ClipboardButton value={link} size="sm" variant="secondary" />
                <Button variant="secondary" size="sm" onClick={() => window.open(link, "_blank", "noopener")}>
                  Open
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <section aria-label="Issued child keys" style={{ display: "grid", gap: 8 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <strong style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Users size={14} /> Recipients
            </strong>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void summary.refetch()}
              icon={<RefreshCw size={13} />}
            >
              Refresh
            </Button>
          </div>
          <Input
            label="Search recipients"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Prefix, masked IP, or key id"
          />
          {summary.isPending && !summary.data ? (
            <LoadingState label="Loading recipients…" />
          ) : summary.isError ? (
            <ErrorState
              message={getErrorMessage(summary.error, "Could not load share activity.")}
              onRetry={() => void summary.refetch()}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title="No recipients yet"
              message="Issued child keys will appear here with masked client IP and aggregate usage."
            />
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {filtered.map((child: SharedKeySummary) => (
                <section
                  key={child.id}
                  style={{ border: "1px solid var(--inner-border)", borderRadius: 10, overflow: "hidden" }}
                >
                  <div className="share-recipient-main">
                    <div className="share-recipient-identity">
                      <div>
                        <button
                          type="button"
                          className="share-recipient-key"
                          aria-expanded={expanded === child.id}
                          onClick={() => setExpanded(expanded === child.id ? null : child.id)}
                        >
                          {expanded === child.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span>{child.keyPrefix ?? "key"}…</span>
                        </button>
                        <div className="share-recipient-context">
                          {child.issuedClientIp ?? "IP hidden"} <span aria-hidden="true">·</span>{" "}
                          {child.revokedAt ? "revoked" : "active"}
                        </div>
                      </div>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={revoke.isPending || Boolean(child.revokedAt)}
                        onClick={() =>
                          revoke.mutate(
                            { parentKeyId: parent.id, childKeyId: child.id },
                            {
                              onError: (error) =>
                                toast.error(getErrorMessage(error, "Could not revoke child key.")),
                            },
                          )
                        }
                      >
                        Revoke
                      </Button>
                    </div>
                    <dl className="share-recipient-metrics">
                      <div>
                        <dt>Today requests</dt>
                        <dd>{count(child.today.requests)}</dd>
                      </div>
                      <div>
                        <dt>Today errors</dt>
                        <dd>{count(child.today.errors)}</dd>
                      </div>
                      <div>
                        <dt>Today tokens</dt>
                        <dd>{count(child.today.totalTokens)}</dd>
                      </div>
                      <div>
                        <dt>Lifetime requests</dt>
                        <dd>{count(child.allTime.requests)}</dd>
                      </div>
                      <div>
                        <dt>Lifetime errors</dt>
                        <dd>{count(child.allTime.errors)}</dd>
                      </div>
                      <div>
                        <dt>Lifetime tokens</dt>
                        <dd>{count(child.allTime.totalTokens)}</dd>
                      </div>
                    </dl>
                    <p className="share-recipient-dates">
                      Registered {stamp(child.createdAt)} <span aria-hidden="true">·</span> Last activity{" "}
                      {stamp(child.lastUsedAt)}
                    </p>
                  </div>
                  {expanded === child.id && <ChildDetail parentId={parent.id} childId={child.id} />}
                </section>
              ))}
            </div>
          )}
        </section>

        <p style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
          Masked identity; live telemetry refreshes every five seconds. Lifetime totals use retained
          telemetry available at rollout.
        </p>
      </div>
    </Dialog>
  );
}
