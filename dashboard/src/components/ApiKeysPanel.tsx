import {
  Activity,
  Clock3,
  Gauge,
  KeyRound,
  ListChecks,
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
import { Input } from "./ui/input";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { StatCard } from "./ui/layout";
import { ApiKeyForm, oneTimeSecretForMode, type KeyFormInput } from "./ApiKeyForm";
import { ConfirmDialog } from "./ConfirmDialog";
import { ClipboardButton } from "./patterns/clipboard-button";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import type { ApiKeyResponse, ShareKeyResponse } from "../lib/contracts";
import { useApiKeys, useCreateApiKey, useRevokeApiKey, useShareApiKey, useUpdateApiKey } from "../lib/hooks/api-keys";

/** Compact K/M/B/T token count used by the panel's stat cards and rows. */
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
  const shareKey = useShareApiKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyResponse | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ApiKeyResponse | null>(null);
  const [shareResult, setShareResult] = useState<ShareKeyResponse | null>(null);
  const [shareExpiry, setShareExpiry] = useState("");

  const keys = keysQuery.data ?? [];
  const activeKeys = keys.filter((key) => !key.revokedAt).length;
  const totalUsage = keys.reduce((sum, key) => sum + Math.max(0, key.tokensConsumed ?? 0), 0);

  const openShare = (key: ApiKeyResponse) => {
    setRevealedSecret(null);
    setShareResult(null);
    setShareExpiry("");
    setShareTarget(key);
  };
  const confirmShare = () => {
    if (!shareTarget) return;
    let expiresAt: string | undefined;
    if (shareExpiry) {
      const parsed = new Date(shareExpiry);
      if (Number.isNaN(parsed.getTime())) {
        toast.error("Enter a valid expiry date or leave it empty.");
        return;
      }
      expiresAt = parsed.toISOString();
    }
    shareKey.mutate(
      { keyId: shareTarget.id, expiresAt },
      {
        onSuccess: (result) => setShareResult(result),
        onError: (error) => toast.error(getErrorMessage(error, "Could not create share link.")),
      },
    );
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
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "10px",
            marginBottom: "16px",
          }}
        >
          <StatCard
            label="Active keys"
            icon={<Gauge size={12} />}
            tone="accent"
            value={`${activeKeys} / ${keys.length}`}
            detail="not revoked"
          />
          <StatCard
            label="Total usage"
            icon={<Activity size={12} />}
            tone="teal"
            value={compactTokens(totalUsage)}
            detail="all-time tokens"
          />
          <StatCard
            label="Total requests"
            icon={<ListChecks size={12} />}
            tone="purple"
            value={keys.length.toLocaleString()}
            detail="issued credentials"
          />
          <StatCard
            label="Revoked"
            icon={<Clock3 size={12} />}
            tone={keys.length - activeKeys > 0 ? "orange" : "green"}
            value={String(keys.length - activeKeys)}
            detail="no longer accepted"
          />
        </div>

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
                  {key.keyMode === "share" && <Button
                    variant="secondary"
                    size="sm"
                    icon={<Share2 size={13} />}
                    onClick={() => openShare(key)}
                    disabled={Boolean(key.revokedAt)}
                  >
                    Create enrollment link
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

      <Dialog
        open={shareTarget !== null}
        onClose={() => { setShareTarget(null); setShareResult(null); }}
        title="Create enrollment link"
        width={560}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            This link lets a visitor manually generate one child credential. The share template itself never authenticates requests, and each active IP can enroll once.
          </p>
          {shareResult ? (
            <div style={{ display: "grid", gap: 8 }}>
              <code style={{ display: "block", padding: 8, borderRadius: 8, background: "var(--surface-1)", border: "1px solid var(--inner-border)", fontSize: 11.5, overflowWrap: "anywhere" }}>{shareResult.url}</code>
              <div style={{ display: "flex", gap: 8 }}>
                <ClipboardButton value={shareResult.url} size="sm" variant="secondary" />
                <Button variant="secondary" size="sm" onClick={() => window.open(shareResult.url, "_blank", "noopener")}>Open</Button>
              </div>
              <p style={{ fontSize: 11, color: "var(--text-tertiary)" }}>The enrollment URL contains a one-time link token. Store and share it carefully.</p>
            </div>
          ) : (
            <>
              <Input label="Expires" hint="optional" type="datetime-local" value={shareExpiry} onChange={(event) => setShareExpiry(event.target.value)} />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Button variant="secondary" size="sm" onClick={() => setShareTarget(null)} disabled={shareKey.isPending}>Cancel</Button>
                <Button variant="primary" size="sm" onClick={confirmShare} disabled={shareKey.isPending} icon={<Share2 size={13} />}>{shareKey.isPending ? "Creating…" : "Create link"}</Button>
              </div>
            </>
          )}
        </div>
      </Dialog>

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
