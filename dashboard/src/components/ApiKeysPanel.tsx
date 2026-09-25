import {
  KeyRound,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ApiKeyForm, oneTimeSecretForMode, type KeyFormInput } from "./ApiKeyForm";
import { ConfirmDialog } from "./ConfirmDialog";
import { ClipboardButton } from "./patterns/clipboard-button";
import { ShareManagementDialog } from "./ShareManagementDialog";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import type { ApiKeyResponse } from "../lib/contracts";
import { useApiKeys, useCreateApiKey, useRevokeApiKey, useUpdateApiKey } from "../lib/hooks/api-keys";

/** Compact K/M/B/T token count used by the credential rows. */
function compactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const amount = Math.max(0, value);
  if (amount >= 1_000_000_000_000) return `${Number((amount / 1_000_000_000_000).toFixed(2))}T`;
  if (amount >= 1_000_000_000) return `${Number((amount / 1_000_000_000).toFixed(2))}B`;
  if (amount >= 1_000_000) return `${Number((amount / 1_000_000).toFixed(2))}M`;
  if (amount >= 1_000) return `${Number((amount / 1_000).toFixed(2))}K`;
  return amount.toLocaleString();
}


function limitLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unlimited";
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/**
 * API-key management panel: access, budgets, usage, and share links.
 *
 * Secrets are never returned by the list endpoint, so the panel shows only the
 * public prefix; a newly created key's secret is revealed exactly once.
 */
export function ApiKeysPanel(): ReactNode {
  const keysQuery = useApiKeys();
  const createKey = useCreateApiKey();
  const updateKey = useUpdateApiKey();
  const revokeKey = useRevokeApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyResponse | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ApiKeyResponse | null>(null);

  const keys = keysQuery.data ?? [];

  const openShare = (key: ApiKeyResponse) => {
    setRevealedSecret(null);
    setShareTarget(key);
  };

  return (
    <Card>
      <CardHeader
        title="API Credentials"
        subtitle="Manage routing client keys, budgets, allow lists, and share links"
        icon={<KeyRound size={16} />}
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setRevealedSecret(null); setCreateOpen(true); }}
            icon={<Plus size={13} />}
          >
            Create Key
          </Button>
        }
      />
      <CardBody>
        {revealedSecret ? (
          <div
            style={{
              padding: "14px",
              borderRadius: "12px",
              border: "1px solid var(--accent-soft)",
              background: "var(--accent-soft)",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                marginBottom: "6px",
              }}
            >
              <strong style={{ fontSize: "12.5px", color: "var(--accent)" }}>
                New Secret Key Generated
              </strong>
              <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                Copy now — only shown once!
              </span>
            </div>
            <code
              style={{
                display: "block",
                padding: "8px 12px",
                borderRadius: "8px",
                background: "var(--surface-1)",
                border: "1px solid var(--inner-border)",
                fontSize: "12px",
                wordBreak: "break-all",
                color: "var(--text-primary)",
              }}
            >
              {revealedSecret}
            </code>
            <div style={{ marginTop: "8px" }}>
              <ClipboardButton value={revealedSecret} size="sm" variant="secondary" />
            </div>
          </div>
        ) : null}

        {keysQuery.isPending && !keysQuery.data ? (
          <LoadingState label="Loading API keys…" />
        ) : keysQuery.isError && !keysQuery.data ? (
          <ErrorState
            message={getErrorMessage(keysQuery.error, "Could not load credentials.")}
            onRetry={() => void keysQuery.refetch()}
          />
        ) : keys.length === 0 ? (
          <EmptyState
            title="No API keys issued"
            message="Generate a secret key to authenticate your SDK or CLI client against the gateway."
            icon={<KeyRound size={20} />}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {keys.map((key) => (
              <div
                key={key.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: "12px",
                  padding: "12px 14px",
                  borderRadius: "12px",
                  border: "1px solid var(--inner-border)",
                  background: "var(--surface-2)",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}
                  >
                    <strong style={{ fontSize: "13px" }}>
                      {key.label || "Unnamed credential"}
                    </strong>
                    <Badge tone={key.revokedAt ? "err" : "ok"}>
                      {key.revokedAt ? "revoked" : "active"}
                    </Badge>
                    <Badge tone={key.keyMode === "share" ? "accent" : "default"}>
                      {key.keyMode === "share" ? "share template" : "personal"}
                    </Badge>
                  </div>
                  <code
                    style={{
                      display: "block",
                      marginTop: "2px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "11px",
                      color: "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {key.keyPrefix ? `${key.keyPrefix}…` : `${key.id.slice(0, 12)}…`}
                  </code>
                  <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "2px" }}>
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      flexWrap: "wrap",
                      marginTop: "6px",
                      fontSize: "10.5px",
                      color: "var(--text-tertiary)",
                    }}
                  >
                    <span>Usage {compactTokens(key.tokensConsumed)}</span>
                    <span>RPM {limitLabel(key.requestsPerMinute)}</span>
                    <span>Daily {limitLabel(key.dailyTokenLimit)}</span>
                    <span>Monthly {limitLabel(key.monthlyTokenLimit)}</span>
                    <span>One-time {limitLabel(key.lifetimeTokenBudget)}</span>
                    <span>Concurrent {limitLabel(key.maxConcurrentRequests)}</span>
                    <span>Models {key.modelAllowlist?.length ?? "All"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Pencil size={13} />}
                    onClick={() => { setRevealedSecret(null); setEditTarget(key); }}
                  >
                    Edit
                  </Button>
                  {!key.revokedAt && <Button
                    variant="secondary"
                    size="sm"
                    icon={<Share2 size={13} />}
                    onClick={() => openShare(key)}
                  >
                    {key.keyMode === "share" ? "Recipients" : "Share"}
                  </Button>}
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    onClick={() => setRevokeTarget(key)}
                    disabled={Boolean(key.revokedAt) || revokeKey.isPending}
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardBody>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="Create API Key" width={680}>
        <ApiKeyForm
          mode="create"
          record={null}
          busy={createKey.isPending}
          onClose={() => setCreateOpen(false)}
          onDone={(input: KeyFormInput) => {
            createKey.mutate(input, {
              onSuccess: (res) => {
                setCreateOpen(false);
                setRevealedSecret(oneTimeSecretForMode(input.keyMode, res.secret));
              },
              onError: (error) => toast.error(getErrorMessage(error, "Could not create API key.")),
            });
          }}
        />
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit API Key"
        width={760}
      >
        <ApiKeyForm
          mode="edit"
          record={editTarget}
          busy={updateKey.isPending}
          onClose={() => setEditTarget(null)}
          onDone={(input: KeyFormInput) => {
            if (!editTarget) return;
            updateKey.mutate(
              { keyId: editTarget.id, request: input },
              {
                onSuccess: (res) => {
                  setEditTarget(null);
                  setRevealedSecret(oneTimeSecretForMode(input.keyMode, res.secret));
                },
                onError: (error) => toast.error(getErrorMessage(error, "Could not update API key.")),
              },
            );
          }}
        />
      </Dialog>

      {shareTarget ? (
        <ShareManagementDialog parent={shareTarget} onClose={() => setShareTarget(null)} />
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (!revokeTarget) return;
          await revokeKey.mutateAsync(revokeTarget.id);
          toast.success(`Revoked ${revokeTarget.label || revokeTarget.id}.`);
          setRevokeTarget(null);
        }}
        title="Revoke API key?"
        message={
          revokeTarget
            ? `Revoke ${revokeTarget.label || revokeTarget.id}? Clients using it will be rejected.${revokeTarget.keyMode === "share" ? " All child keys and enrollment links will also be revoked." : ""}`
            : "Revoke this API key?"
        }
        confirmLabel="Revoke"
        danger
      />

    </Card>
  );
}
