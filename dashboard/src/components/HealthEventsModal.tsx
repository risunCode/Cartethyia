import { Activity, RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { CredentialKind, CredentialMode } from "../data/contracts";
import { ConfirmDialog } from "./ConfirmDialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { DataTable } from "./ui/layout";
import { Inline } from "./ui/inline";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { useAccountHealthEvents, useRecoverAccount, useUpdateProviderAccount } from "../hooks/providers";
import { toast } from "../lib/toast";
/**
 * The account health & error log dialog shared by the Quota page and provider detail.
 */
export interface AccountHealthSummary {
  readonly providerId: string;
  readonly accountId: string;
  /** Dialog title suffix — the account's label, name, or a short id. */
  readonly title: string;
  readonly status: string;
  /** Error category badge, when the account's last failure has one. */
  readonly errorCategory?: string | undefined;
  /** Operator-facing error text, already sanitized by the backend. */
  readonly errorMessage?: string | undefined;
  /** Empty-state copy differs by page: the Quota view also lists check-ins. */
  readonly emptyMessage: string;
  readonly staticToken?: boolean;
  readonly credentialKind?: CredentialKind;
  readonly credentialMode?: CredentialMode;
}

/** Recovery is offered for the one transient state the backend can recover. */
function isRecoverable(status: string): boolean {
  return status === "cooldown";
}

function statusTone(status: string): "ok" | "disabled" | "warn" {
  if (status === "active") return "ok";
  if (status === "disabled") return "disabled";
  return "warn";
}
function staticModeCopy(enabling: boolean, title: string): {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
} {
  return enabling
    ? {
        title: "Enable static-token mode?",
        message: `${title} will be used exactly as issued and will not be refreshed. Re-enable refresh before this token expires.`,
        confirmLabel: "Enable static mode",
      }
    : {
        title: "Re-enable credential refresh?",
        message: `${title} will return to the OAuth refresh sweep. Use this only when a refresh token is available.`,
        confirmLabel: "Re-enable refresh",
      };
}

export function HealthEventsModal({
  summary,
  onClose,
}: {
  readonly summary: AccountHealthSummary;
  readonly onClose: () => void;
}): ReactNode {
  const { providerId, accountId, title, status, errorCategory, errorMessage } = summary;
  const query = useAccountHealthEvents(providerId, accountId);
  const recover = useRecoverAccount();
  const events = query.data ?? [];
  const update = useUpdateProviderAccount();
  const canManageStaticMode =
    summary.credentialKind === "oauth" ||
    summary.credentialMode === "jwt" ||
    summary.staticToken === true;
  const [staticMode, setStaticMode] = useState(summary.staticToken === true);
  const [staticConfirm, setStaticConfirm] = useState<boolean | null>(null);
  useEffect(() => setStaticMode(summary.staticToken === true), [summary.staticToken]);

  return (
    <Dialog open={true} onClose={onClose} title={`Health & Error Log — ${title}`} size="lg">
      <div className="flex flex-col gap-7 min-w-0">
        <div
          className="flex flex-wrap items-center justify-between gap-5 rounded-control border border-inner-border bg-surface-2 py-5 px-7"
        >
          <div className="min-w-0">
            <Inline gap="8px" className="flex-wrap">
              <span className="text-body font-semibold">Account status:</span>
              <Badge tone={statusTone(status)} dot>{status.toUpperCase()}</Badge>
              {errorCategory ? (
                <Badge tone="warn" title={errorMessage ?? undefined}>{errorCategory}</Badge>
              ) : null}
            </Inline>
            {errorMessage ? (
              <p className="text-badge text-red mt-2 wrap-anywhere">
                {errorMessage}
              </p>
            ) : null}
          </div>
          {isRecoverable(status) ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<RotateCcw size={12} className={recover.isPending ? "animate-spin" : ""} />}
              disabled={recover.isPending}
              onClick={() => recover.mutate({ providerId, accountId }, { onSuccess: () => void query.refetch() })}
            >
              {recover.isPending ? "Recovering..." : "Recover Now"}
            </Button>
          ) : null}
        </div>

        {canManageStaticMode ? (
          <div
            className="flex items-center justify-between gap-6 rounded-control border border-inner-border bg-surface-2 py-5 px-7"
          >
            <div>
              <div className="text-caption font-semibold">Credential management</div>
              <div className="text-badge text-text-tertiary">
                {staticMode ? "Static mode: no refresh request will be sent." : "OAuth refresh is enabled for this account."}
              </div>
            </div>
            <Button
              size="sm"
              variant={staticMode ? "primary" : "secondary"}
              disabled={update.isPending}
              onClick={() => setStaticConfirm(!staticMode)}
            >
              {staticMode ? "Static · no refresh" : "Enable static mode"}
            </Button>
          </div>
        ) : null}
        <div className="min-w-0">
          <h4
            className="text-caption font-semibold text-text-secondary mb-4"
          >
            Transition Events & Audit ({events.length})
          </h4>
          {query.isPending ? (
            <LoadingState label="Loading health events..." />
          ) : query.isError ? (
            <ErrorState message="Failed to load health events" onRetry={() => void query.refetch()} />
          ) : events.length === 0 ? (
            <EmptyState title="No health events recorded" message={summary.emptyMessage} icon={<Activity size={20} />} />
          ) : (
            <div className="rounded-inset border border-inner-border">
              <DataTable
                maxHeight={480}
                scrollRegion
                headers={["Timestamp", "From → To", "Model", "Category", "Reason / Details"]}
              >
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td className="text-badge text-text-tertiary whitespace-nowrap">
                      {new Date(ev.createdAt).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="text-badge text-text-secondary">
                        {ev.fromStatus ?? "new"} →{" "}
                      </span>
                      <Badge tone={statusTone(ev.toStatus)}>{ev.toStatus}</Badge>
                    </td>
                    <td className="font-mono tabular-nums text-badge text-text-secondary wrap-anywhere">
                      {ev.modelId ?? "—"}
                    </td>
                    <td className="font-mono tabular-nums text-badge text-text-secondary">
                      {ev.errorCategory ?? "—"}
                    </td>
                    <td className="text-badge text-text-primary min-w-110 max-w-260 wrap-anywhere">
                      {ev.reason ?? "—"}
                    </td>
                  </tr>
                ))}
              </DataTable>
            </div>
          )}
        </div>

        <ConfirmDialog
          open={staticConfirm !== null}
          onClose={() => setStaticConfirm(null)}
          onConfirm={() => {
            const next = staticConfirm === true;
            update.mutate(
              { providerId, accountId, request: { staticToken: next } },
              {
                onSuccess: () => {
                  setStaticMode(next);
                  setStaticConfirm(null);
                  toast.success(next ? "Static mode enabled" : "Credential refresh re-enabled", title);
                  void query.refetch();
                },
                onError: (error) =>
                  toast.error("Credential update failed", error instanceof Error ? error.message : "Unable to update credential mode"),
              },
            );
          }}
          title={staticModeCopy(staticConfirm === true, title).title}
          message={staticModeCopy(staticConfirm === true, title).message}
          confirmLabel={staticModeCopy(staticConfirm === true, title).confirmLabel}
          cancelLabel="Cancel"
        />
        <Inline justify="flex-end" gap="0px">
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </Inline>
      </div>
    </Dialog>
  );
}
