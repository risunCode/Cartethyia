import { ChevronDown, ChevronRight, Link2, RefreshCw, RotateCw } from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Dialog } from "./ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ClipboardButton } from "./patterns/clipboard-button";
import { toast } from "../shared/toast";
import { getErrorMessage } from "../shared/helpers";
import { quotaBarTone } from "../shared/quota-formatters";
import type { ApiKeyResponse, SharedKeyActivityDetail, SharedKeySummary } from "../data/contracts";
import {
  useRegenerateApiKey,
  useRevokeSharedKey,
  useShareApiKey,
  useShareLink,
  useSharedKeyActivity,
  useSharedKeys,
} from "../hooks/api-keys";

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

/** One limit rendered as a compact labelled figure; "Unlimited" when unset. */
function Limit({ label, value }: { label: string; value: number | null | undefined }): ReactNode {
  return (
    <div className="share-stat">
      <dt>{label}</dt>
      <dd>{value == null ? "Unlimited" : count(value)}</dd>
    </div>
  );
}

/**
 * What regenerating costs, per key mode.
 *
 * Exported so the confirmation copy is testable without a DOM: `Dialog` renders
 * through `createPortal` behind a `mounted` effect, which never runs under
 * `renderToStaticMarkup`, so the dialog's body cannot be asserted through a
 * render. The two modes destroy different things and the copy must not be
 * swapped between them, which is exactly what needs a test.
 */
export function regenerateWarning(isPersonal: boolean): {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
} {
  if (isPersonal)
    return {
      title: "Regenerate this key?",
      message:
        "This rotates the key credential. Any client still using the current secret starts getting 401s immediately, and the old secret cannot be recovered. The handoff link is re-pointed to reveal the new key.",
      confirmLabel: "Regenerate key",
    };
  return {
    title: "Regenerate this link?",
    message:
      "This replaces the link URL; the current URL stops resolving immediately. Recipients keep the keys they already generated and keep working — but no one can enroll through the old link again.",
    confirmLabel: "Regenerate link",
  };
}

/**
 * Lifetime-budget consumption as a bar.
 *
 * Only the lifetime budget can be drawn honestly. The gateway enforces daily and
 * monthly token limits from in-memory windows in the admission service, which are
 * never persisted and never sent to the console, so the only counter the response
 * carries is `tokensConsumed` (lifetime). Drawing a daily or monthly bar would
 * mean rendering a zero the operator had no way to distinguish from a real zero.
 *
 * With no budget set the bar is drawn full and green: nothing is being consumed
 * against a limit, so the honest reading is headroom, not an empty bar that
 * would imply an exhausted budget.
 */
function BudgetBar({
  consumed,
  budget,
}: {
  readonly consumed: number;
  readonly budget: number | null | undefined;
}): ReactNode {
  const unlimited = budget == null || budget <= 0;
  const pct = unlimited ? 100 : Math.min(100, (consumed / budget) * 100);
  // Over-budget reads as full rather than clipping: the number is what tells the
  // operator they are past it, and a bar that shrinks back would imply headroom.
  const exhausted = !unlimited && consumed >= budget;
  return (
    <div className="share-budget">
      <div className="share-budget-head">
        <span>Lifetime budget</span>
        <span className="share-budget-figures">
          {unlimited
            ? `${compactTokens(consumed)} · Unlimited`
            : `${compactTokens(consumed)} / ${compactTokens(budget)}`}
        </span>
      </div>
      <div
        className="share-bar-track"
        role="progressbar"
        aria-label="Lifetime token budget consumed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={
          unlimited
            ? `${compactTokens(consumed)} tokens consumed, no lifetime budget set`
            : `${compactTokens(consumed)} of ${compactTokens(budget)} tokens consumed`
        }
      >
        <div
          className={`share-bar-fill${exhausted ? " share-bar-fill--exhausted" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Active recipient count: child keys that have not been revoked. */
function activeChildCount(children: readonly SharedKeySummary[]): number {
  return children.filter((child) => child.revokedAt === null).length;
}

/**
 * Total tokens spent across all recipients (active or revoked): the parent's
 * global consumption, matching the quota the gateway enforces per request.
 */
function childrenTotal(children: readonly SharedKeySummary[]): number {
  return children.reduce((sum, child) => sum + child.allTime.totalTokens, 0);
}

/**
 * Parent-level quota bar: consumed vs budget, with the remaining pill.
 *
 * Same visual language as the quota page (`quota-bar-*` tones by remaining
 * percent), but the numbers here are the parent's: total children consumption
 * against the parent's lifetime budget, or the raw total when no budget is
 * set. Shown in its own section below the link, above the recipients table.
 */
function ParentQuotaBar({
  consumed,
  budget,
}: {
  readonly consumed: number;
  readonly budget: number | null | undefined;
}): ReactNode {
  if (budget == null) {
    return (
      <div className="share-budget">
        <div className="share-budget-head">
          <span>Total quota used</span>
          <span className="share-budget-figures">{compactTokens(consumed)}</span>
        </div>
      </div>
    );
  }
  const pct = budget > 0 ? Math.min(100, (consumed / budget) * 100) : 0;
  const remaining = budget > 0 ? Math.max(0, 100 - (consumed / budget) * 100) : 100;
  const left = Math.max(0, budget - consumed);
  const colors = quotaBarTone(consumed >= budget ? 0 : remaining);
  const exhausted = consumed >= budget;
  return (
    <div className="share-budget">
      <div className="share-budget-head">
        <span>Total quota</span>
        <span className="share-budget-figures">
          {compactTokens(consumed)} / {compactTokens(budget)}
        </span>
        <span
          className="share-quota-pill"
          style={{ color: colors.text, borderColor: colors.text }}
        >
          {exhausted ? "Exhausted" : `${compactTokens(left)} left`}
        </span>
      </div>
      <div
        className="share-bar-track"
        role="progressbar"
        aria-label="Total quota consumed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${compactTokens(consumed)} of ${compactTokens(budget)} tokens consumed`}
      >
        <div
          className={`share-bar-fill${exhausted ? " share-bar-fill--exhausted" : ""}`}
          style={{ width: `${pct}%`, background: exhausted ? undefined : colors.bar }}
        />
      </div>
    </div>
  );
}

/** Expanded recipient body: model totals and recent requests, loaded on demand. */
export function ChildDetail({ parentId, childId }: { parentId: string; childId: string }): ReactNode {
  const detail = useSharedKeyActivity(parentId, childId);
  if (detail.isPending) return <LoadingState label="Loading activity…" compact />;
  if (detail.isError) {
    return (
      <ErrorState
        compact
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
          <div className="data-table-container">
            <table className="data-table share-table">
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
          </div>
        ) : (
          <p className="share-detail-empty">No model activity yet.</p>
        )}
      </section>
      <section>
        <h4 className="share-detail-heading">Recent requests</h4>
        {activity.requests.length ? (
          <div className="data-table-container">
            <table className="data-table share-table">
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
          </div>
        ) : (
          <p className="share-detail-empty">No recent requests.</p>
        )}
      </section>
    </div>
  );
}

/**
 * The dialog's body. Split from the portal so the section logic — which query
 * is enabled, which section a key mode gets — is renderable without a DOM,
 * which the `Dialog`'s `createPortal` requires.
 */
export function ShareManagementContent({
  parent,
  onSecretRevealed,
}: {
  parent: ApiKeyResponse;
  /**
   * Called with the freshly generated plaintext when a personal key's
   * credential is rotated. The owner needs to read the new secret, and the
   * console returns it only once, so the host surfaces it in the one-time
   * reveal dialog rather than leaving the rotate as a toast the operator cannot
   * act on.
   */
  onSecretRevealed?: (secret: string) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState<string | null>(null);
  const share = useShareApiKey();
  const regenerate = useRegenerateApiKey();
  const revoke = useRevokeSharedKey();
  const link = useShareLink(parent.id);
  const isPersonal = parent.keyMode !== "share";
  // A personal key has no recipients: `/shared-keys` is a share-template route
  // and answers 404 for it, so the query stays disabled instead of rendering an
  // error box over the key's own usage.
  const summary = useSharedKeys(isPersonal ? null : parent.id);
  const children = summary.data ?? [];

  useEffect(() => {
    setExpanded(null);
  }, [parent.id]);

  const busy = share.isPending || regenerate.isPending;
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);

  /**
   * Regenerating is irreversible, so it confirms first.
   *
   * The two modes destroy different things, which is why the copy is not shared.
   * A personal key's regenerate rotates the credential itself, so every client
   * still holding the old secret starts getting 401s. A share template's
   * regenerate rotates only the link token in place (`share_links` is updated,
   * not re-created), so the old URL stops resolving while recipients keep the
   * keys they already generated — nothing they hold is deleted. Saying "all old
   * keys are deleted" would be false for share mode, and saying "recipients keep
   * their keys" would be dangerous for personal mode.
   */
  const onRegenerate = async (): Promise<void> => {
    if (isPersonal) {
      const result = await regenerate.mutateAsync({ keyId: parent.id });
      // The new secret is returned once: hand it to the host so it can be shown
      // in the one-time reveal dialog. A toast alone would leave the operator
      // unable to read the credential they just rotated to.
      onSecretRevealed?.(result.secret);
      return;
    }
    await share.mutateAsync({ keyId: parent.id, regenerate: true });
    toast.success("Link regenerated; the previous URL no longer works.");
  };

  const onEnsureLink = () => {
    share.mutate(
      { keyId: parent.id },
      { onError: (error) => toast.error(getErrorMessage(error, "Could not create link.")) },
    );
  };

  const url = link.data?.url ?? null;
  const warning = regenerateWarning(isPersonal);

  return (
    <div className="share-modal">
      <section aria-label="Link">
        {link.isPending ? (
          <LoadingState label="Loading link…" compact />
        ) : link.isError ? (
          <ErrorState
            compact
            message={getErrorMessage(link.error, "Could not load the link.")}
            onRetry={() => void link.refetch()}
          />
        ) : url ? (
          <div className="share-link-row">
            <Link2 size={14} aria-hidden="true" />
            {/* The URL truncates to keep the row from scrolling the modal; the
                full value stays readable on hover and Copy takes it verbatim. */}
            <code title={url}>{url}</code>
            <ClipboardButton value={url} size="sm" variant="secondary" label="Copy" copiedLabel="Copied" />
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCw size={13} />}
              loading={busy}
              disabled={busy}
              onClick={() => setConfirmingRegenerate(true)}
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

      {isPersonal ? (
        <section aria-label="Usage" className="share-section">
          <div className="share-section-head">
            <strong>Usage</strong>
          </div>
          <dl className="share-stats">
            <div className="share-stat">
              <dt>Lifetime tokens</dt>
              <dd>{compactTokens(parent.tokensConsumed)}</dd>
            </div>
            <Limit label="Requests / min" value={parent.requestsPerMinute} />
            <Limit label="Daily tokens" value={parent.dailyTokenLimit} />
            <Limit label="Monthly tokens" value={parent.monthlyTokenLimit} />
            <BudgetBar consumed={parent.tokensConsumed} budget={parent.lifetimeTokenBudget} />
          </dl>
        </section>
      ) : (
        <>
          <section aria-label="Total quota" className="share-section">
            <div className="share-section-head">
              <strong>Total quota</strong>
            </div>
            <ParentQuotaBar
              consumed={childrenTotal(children)}
              budget={parent.lifetimeTokenBudget}
            />
          </section>
          <section aria-label="Recipients" className="share-section">
          <div className="share-section-head">
            <strong>Recipients</strong>
            {/* Counting only unrevoked children: a revoked key is still listed
                for its usage history, but it can no longer be used, so folding
                it into "active" would overstate who can still call the gateway. */}
            <span className="share-active-count">
              Active users: {activeChildCount(children)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void summary.refetch()}
              icon={
                /* A refresh with no visible motion reads as a dead button: the
                   list already polls every 5s, so a manual refresh that looks
                   identical to an idle one gives the operator no evidence their
                   click did anything. Spin only while the refetch is in flight. */
                <RefreshCw size={13} className={summary.isFetching ? "animate-spin" : undefined} />
              }
            >
              Refresh
            </Button>
          </div>
          {summary.isPending && !summary.data ? (
            <LoadingState label="Loading recipients…" compact />
          ) : summary.isError ? (
            <ErrorState
              compact
              message={getErrorMessage(summary.error, "Could not load recipients.")}
              onRetry={() => void summary.refetch()}
            />
          ) : children.length === 0 ? (
            <EmptyState
              compact
              title="No recipients yet"
              message="Keys generated through this link appear here with their masked client IP and token usage."
            />
          ) : (
            <div className="data-table-container share-table-container">
              <table className="data-table share-table">
                <thead>
                  <tr>
                    <th scope="col" className="share-col-toggle" aria-label="Expand" />
                    <th scope="col">Key</th>
                    <th scope="col">Status</th>
                    <th scope="col">Today</th>
                    <th scope="col">Lifetime</th>
                    <th scope="col">Last activity</th>
                    <th scope="col" className="share-col-actions">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {children.map((child: SharedKeySummary) => {
                    const open = expanded === child.id;
                    return (
                      <Fragment key={child.id}>
                        <tr>
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
                            <code>{child.label || child.keyPrefix || "key"}…</code>
                            <div className="share-recipient-context">
                              {child.issuedClientIp ?? "IP hidden"}
                            </div>
                          </td>
                          <td>{child.revokedAt ? "revoked" : "active"}</td>
                          <td>{compactTokens(child.today.totalTokens)}</td>
                          <td>{compactTokens(child.allTime.totalTokens)}</td>
                          <td>{stamp(child.lastUsedAt)}</td>
                          <td className="share-col-actions">
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
                          <tr>
                            <td colSpan={7} style={{ padding: 0 }}>
                              <ChildDetail parentId={parent.id} childId={child.id} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          </section>
        </>
      )}
        {/* Nested rather than a sibling: `Dialog` renders through
            `createPortal`, so this adds no DOM child and cannot become a stray
            row in the `.share-modal` grid. */}
        <ConfirmDialog
          open={confirmingRegenerate}
          onClose={() => setConfirmingRegenerate(false)}
          onConfirm={onRegenerate}
          title={warning.title}
          message={warning.message}
          confirmLabel={warning.confirmLabel}
          danger
        />
      </div>
  );
}

export function ShareManagementDialog({
  parent,
  onClose,
  onSecretRevealed,
}: {
  parent: ApiKeyResponse;
  onClose: () => void;
  onSecretRevealed: (secret: string) => void;
}): ReactNode {
  const isPersonal = parent.keyMode !== "share";
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
      width={720}
    >
      <ShareManagementContent parent={parent} onSecretRevealed={onSecretRevealed} />
    </Dialog>
  );
}
