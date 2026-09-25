import { ChevronDown, ChevronRight, Link2, RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ClipboardButton } from "./patterns/clipboard-button";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import type { ApiKeyResponse, SharedKeyActivityDetail, SharedKeySummary } from "../lib/contracts";
import {
  useRegenerateApiKey,
  useRevokeSharedKey,
  useShareApiKey,
  useShareLink,
  useSharedKeyActivity,
  useSharedKeys,
} from "../lib/hooks/api-keys";

const count = (n: number | null | undefined) => (n ?? 0).toLocaleString();
const stamp = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—");

/** Compact token count; the owner only needs the magnitude at a glance. */
function compactTokens(value: number | null | undefined): string {
  const amount = value ?? 0;
  if (amount >= 1_000_000_000_000) return `${Number((amount / 1_000_000_000_000).toFixed(2))}T`;
  if (amount >= 1_000_000_000) return `${Number((amount / 1_000_000_000).toFixed(2))}B`;
  if (amount >= 1_000_000) return `${Number((amount / 1_000_000).toFixed(2))}M`;
  if (amount >= 1_000) return `${Number((amount / 1_000).toFixed(2))}K`;
  return amount.toLocaleString();
}

/** Expanded recipient body: model totals and recent requests, loaded on demand. */
export function ChildDetail({ parentId, childId }: { parentId: string; childId: string }): ReactNode {
  const detail = useSharedKeyActivity(parentId, childId);
  if (detail.isPending) return <LoadingState label="Loading activity…" />;
  if (detail.isError) {
    return (
      <ErrorState
        message={getErrorMessage(detail.error, "Could not load activity.")}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const activity: SharedKeyActivityDetail | undefined = detail.data;
  if (!activity) return null;
  return (
    <div className="share-child-detail">
      <section>
        <h4 className="share-detail-heading">Top models</h4>
        {activity.models.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Today</th>
                <th scope="col">Errors</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {activity.models.map((model, i) => (
                <tr key={`${model.providerId ?? ""}-${model.modelId}-${i}`}>
                  <td>{model.modelId}</td>
                  <td>{count(model.todayRequests)}</td>
                  <td>{count(model.todayErrors)}</td>
                  <td>{compactTokens(model.todayTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="share-detail-empty">No model activity yet.</p>
        )}
      </section>
      <section>
        <h4 className="share-detail-heading">Recent requests</h4>
        {activity.requests.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Status</th>
                <th scope="col">Tokens</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {activity.requests.map((event) => (
                <tr key={event.requestId}>
                  <td>
                    {event.providerId ?? "Provider"}/{event.modelId ?? "Model"}
                  </td>
                  <td>
                    {event.status}
                    {event.httpStatus ? ` · ${event.httpStatus}` : ""}
                  </td>
                  <td>{compactTokens(event.totalTokens)}</td>
                  <td>{stamp(event.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const share = useShareApiKey();
  const regenerate = useRegenerateApiKey();
  const revoke = useRevokeSharedKey();
  const link = useShareLink(parent.id);
  const summary = useSharedKeys(parent.id);
  const children = summary.data ?? [];
  const isPersonal = parent.keyMode !== "share";

  useEffect(() => {
    setExpanded(null);
  }, [parent.id]);

  const busy = share.isPending || regenerate.isPending;

  const onRegenerate = () => {
    if (isPersonal) {
      regenerate.mutate(
        { keyId: parent.id },
        {
          onSuccess: () => toast.success("Key regenerated; the link now reveals the new key."),
          onError: (error) => toast.error(getErrorMessage(error, "Could not regenerate key.")),
        },
      );
      return;
    }
    share.mutate(
      { keyId: parent.id, regenerate: true },
      {
        onSuccess: () => toast.success("Link regenerated; the previous URL no longer works."),
        onError: (error) => toast.error(getErrorMessage(error, "Could not regenerate link.")),
      },
    );
  };

  const onEnsureLink = () => {
    share.mutate(
      { keyId: parent.id },
      { onError: (error) => toast.error(getErrorMessage(error, "Could not create link.")) },
    );
  };

  const url = link.data?.url ?? null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Sharing — ${parent.label || "API key"}`}
      description={
        isPersonal
          ? "One stable handoff link for this key. Regenerating rotates the key itself."
          : "One stable enrollment link. Regenerating replaces the URL; recipients keep the keys they already generated."
      }
      width={860}
    >
      <div style={{ display: "grid", gap: 16 }}>
        <section aria-label="Link" style={{ display: "grid", gap: 8 }}>
          {link.isPending ? (
            <LoadingState label="Loading link…" />
          ) : link.isError ? (
            <ErrorState
              message={getErrorMessage(link.error, "Could not load the link.")}
              onRetry={() => void link.refetch()}
            />
          ) : url ? (
            <div className="share-link-row">
              <Link2 size={14} aria-hidden="true" />
              <code>{url}</code>
              <ClipboardButton value={url} size="sm" variant="secondary" label="Copy" copiedLabel="Copied" />
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCw size={13} />}
                loading={busy}
                disabled={busy}
                onClick={onRegenerate}
              >
                Regenerate
              </Button>
            </div>
          ) : (
            <div className="share-link-row">
              <Link2 size={14} aria-hidden="true" />
              <span className="share-link-empty">No link yet.</span>
              <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={onEnsureLink}>
                Create link
              </Button>
            </div>
          )}
        </section>

        <section aria-label="Recipients" style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 12 }}>
              {isPersonal ? "Usage" : "Recipients"}
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
          {summary.isPending && !summary.data ? (
            <LoadingState label="Loading recipients…" />
          ) : summary.isError ? (
            <ErrorState
              message={getErrorMessage(summary.error, "Could not load recipients.")}
              onRetry={() => void summary.refetch()}
            />
          ) : children.length === 0 ? (
            <EmptyState
              title="No recipients yet"
              message="Keys generated through this link appear here with their masked client IP and token usage."
            />
          ) : (
            <div className="data-table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: 26 }} aria-label="Expand" />
                    <th scope="col">Key</th>
                    <th scope="col">Status</th>
                    <th scope="col">Today tokens</th>
                    <th scope="col">Lifetime tokens</th>
                    <th scope="col">Last activity</th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {children.map((child: SharedKeySummary) => {
                    const open = expanded === child.id;
                    return (
                      <>
                        <tr key={child.id}>
                          <td>
                            <button
                              type="button"
                              className="share-expand-toggle"
                              aria-expanded={open}
                              aria-label={open ? "Collapse recipient" : "Expand recipient"}
                              onClick={() => setExpanded(open ? null : child.id)}
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          </td>
                          <td>
                            <code>{child.keyPrefix ?? "key"}…</code>
                            <div className="share-recipient-context">
                              {child.issuedClientIp ?? "IP hidden"}
                            </div>
                          </td>
                          <td>{child.revokedAt ? "revoked" : "active"}</td>
                          <td>{compactTokens(child.today.totalTokens)}</td>
                          <td>{compactTokens(child.allTime.totalTokens)}</td>
                          <td>{stamp(child.lastUsedAt)}</td>
                          <td style={{ textAlign: "right" }}>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={revoke.isPending || Boolean(child.revokedAt)}
                              onClick={() =>
                                revoke.mutate(
                                  { parentKeyId: parent.id, childKeyId: child.id },
                                  {
                                    onError: (error) =>
                                      toast.error(getErrorMessage(error, "Could not revoke key.")),
                                  },
                                )
                              }
                            >
                              Revoke
                            </Button>
                          </td>
                        </tr>
                        {open ? (
                          <tr key={`${child.id}-detail`}>
                            <td colSpan={7} style={{ padding: 0 }}>
                              <ChildDetail parentId={parent.id} childId={child.id} />
                            </td>
                          </tr>
                        ) : null}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
