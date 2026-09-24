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
import { Select } from "./ui/select";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { StatCard } from "./ui/layout";
import { ApiKeyForm, type KeyFormInput } from "./ApiKeyForm";
import { ConfirmDialog } from "./ConfirmDialog";
import { ClipboardButton } from "./patterns/clipboard-button";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import type { ApiKeyResponse, ShareKeyResponse, ShareLinkResponse } from "../lib/contracts";
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  useRevokeShareLink,
  useShareApiKey,
  useShareLinks,
  useUpdateApiKey,
} from "../lib/hooks/api-keys";

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

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Unknown";
}

/** Lifecycle label for one share link row. */
function shareStatus(link: ShareLinkResponse): string {
  if (!link.active) return "revoked";
  if (link.usedAt) return "used";
  if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return "expired";
  return "active";
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
  const revokeShare = useRevokeShareLink();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyResponse | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ApiKeyResponse | null>(null);
  const [shareResult, setShareResult] = useState<ShareKeyResponse | null>(null);
  const [shareKind, setShareKind] = useState<"monitor" | "setup">("monitor");
  const [shareExpiry, setShareExpiry] = useState("");
  const [revokeShareTarget, setRevokeShareTarget] = useState<ShareLinkResponse | null>(null);
  // Existing links for the key whose dialog is open; disabled while closed.
  const shareLinks = useShareLinks(shareTarget?.id ?? null);

  const keys = keysQuery.data ?? [];
  const activeKeys = keys.filter((key) => !key.revokedAt).length;
  const totalUsage = keys.reduce((sum, key) => sum + Math.max(0, key.tokensConsumed ?? 0), 0);

  const openShare = (key: ApiKeyResponse) => {
    setShareResult(null);
    setShareKind("monitor");
    setShareExpiry("");
    setShareTarget(key);
  };
  const confirmShare = () => {
    if (!shareTarget) return;
    let expiresAt: string | null = null;
    if (shareExpiry) {
      const parsed = new Date(shareExpiry);
      if (Number.isNaN(parsed.getTime())) {
        toast.error("Enter a valid expiry date or leave it empty.");
        return;
      }
      expiresAt = parsed.toISOString();
    }
    shareKey.mutate(
      { keyId: shareTarget.id, kind: shareKind, expiresAt },
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
            onClick={() => setCreateOpen(true)}
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
                    onClick={() => setEditTarget(key)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Share2 size={13} />}
                    onClick={() => openShare(key)}
                    disabled={Boolean(key.revokedAt)}
                  >
                    Share
                  </Button>
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
          onDone={(input: KeyFormInput & { customKey?: string; prefix?: string }) => {
            createKey.mutate(input as never, {
              onSuccess: (res) => {
                setCreateOpen(false);
                setRevealedSecret((res as { secret?: string }).secret ?? null);
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
          onDone={(input: KeyFormInput & { customKey?: string; prefix?: string }) => {
            if (!editTarget) return;
            updateKey.mutate(
              { keyId: editTarget.id, request: input as never },
              {
                onSuccess: () => setEditTarget(null),
                onError: (error) => toast.error(getErrorMessage(error, "Could not update API key.")),
              },
            );
          }}
        />
      </Dialog>

      <Dialog
        open={shareTarget !== null}
        onClose={() => {
          setShareTarget(null);
          setShareResult(null);
        }}
        title="Share API Key"
        width={560}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Creates a public link showing this key&apos;s live usage, quota, and allowed models.
            Anyone with the link can read the key, so share it only with people you trust.
          </p>
          {shareResult === null ? (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span
                  style={{
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-tertiary)",
                  }}
                >
                  Existing links
                </span>
                {shareLinks.isLoading ? (
                  <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>Loading links…</p>
                ) : (shareLinks.data ?? []).length === 0 ? (
                  <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
                    No share links yet.
                  </p>
                ) : (
                  (shareLinks.data ?? []).map((link) => (
                    <div
                      key={link.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                        padding: "8px 10px",
                        borderRadius: "8px",
                        background: "var(--surface-1)",
                        border: "1px solid var(--inner-border)",
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        <span style={{ fontSize: "12px", color: "var(--text-primary)" }}>
                          {link.kind} · {shareStatus(link)}
                        </span>
                        <span style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                          created {formatDate(link.createdAt)}
                          {link.lastViewedAt ? ` · last viewed ${formatDate(link.lastViewedAt)}` : ""}
                          {link.expiresAt ? ` · expires ${formatDate(link.expiresAt)}` : ""}
                        </span>
                      </div>
                      {link.active ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setRevokeShareTarget(link)}
                          disabled={revokeShare.isPending}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                <Select
                  label="Kind"
                  value={shareKind}
                  onValueChange={(value) => setShareKind(value === "setup" ? "setup" : "monitor")}
                  options={[
                    { value: "monitor", label: "Monitor (live usage page)" },
                    { value: "setup", label: "Setup (one-time key handoff)" },
                  ]}
                />
                <Input
                  label="Expires"
                  hint="optional"
                  type="datetime-local"
                  value={shareExpiry}
                  onChange={(event) => setShareExpiry(event.target.value)}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setShareTarget(null);
                    setShareResult(null);
                  }}
                  disabled={shareKey.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={confirmShare}
                  disabled={shareKey.isPending}
                  icon={<Share2 size={13} />}
                >
                  {shareKey.isPending ? "Creating…" : "Create share link"}
                </Button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <code
                style={{
                  display: "block",
                  padding: "8px 12px",
                  borderRadius: "8px",
                  background: "var(--surface-1)",
                  border: "1px solid var(--inner-border)",
                  fontSize: "11.5px",
                  wordBreak: "break-all",
                  color: "var(--text-primary)",
                }}
              >
                {shareResult.url}
              </code>
              <div style={{ display: "flex", gap: "8px" }}>
                <ClipboardButton value={shareResult.url} size="sm" variant="secondary" />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.open(shareResult.url, "_blank", "noopener")}
                >
                  Open
                </Button>
              </div>
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Created {formatDate(shareResult.expiresAt)} · expires never unless set
              </p>
            </div>
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
            ? `Revoke ${revokeTarget.label || revokeTarget.id}? Clients using it will be rejected.`
            : "Revoke this API key?"
        }
        confirmLabel="Revoke"
        danger
      />

      <ConfirmDialog
        open={revokeShareTarget !== null}
        onClose={() => setRevokeShareTarget(null)}
        onConfirm={async () => {
          if (!revokeShareTarget || !shareTarget) return;
          await revokeShare.mutateAsync({
            keyId: shareTarget.id,
            shareId: revokeShareTarget.id,
          });
          toast.success("Share link revoked.");
        }}
        title="Revoke share link?"
        message="Anyone using this link will immediately lose access to the shared page."
        confirmLabel="Revoke"
        danger
      />
    </Card>
  );
}
