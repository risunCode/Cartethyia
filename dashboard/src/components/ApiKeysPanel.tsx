import {
  KeyRound,
  Pencil,
  Plus,
  RotateCw,
  Share2,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { Switch } from "./ui/switch";
import { ApiKeyForm, oneTimeSecretForMode, type KeyFormInput } from "./ApiKeyForm";
import { ApiKeySecretDialog } from "./ApiKeySecretDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { ModelBansDialog } from "./ModelBansDialog";
import { regenerateWarning, ShareManagementDialog } from "./ShareManagementDialog";
import { SortableList } from "./SortableList";
import { toast } from "../shared/toast";
import { getErrorMessage } from "../shared/helpers";
import { useSessionUser } from "../hooks/system";
import type { ApiKeyResponse } from "../data/contracts";
import {
  useApiKeys,
  useCreateApiKey,
  useRegenerateApiKey,
  useReorderApiKeys,
  useRevokeApiKey,
  useUpdateApiKey,
} from "../hooks/api-keys";

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
  const sessionQuery = useSessionUser();
  const createKey = useCreateApiKey();
  const updateKey = useUpdateApiKey();
  const revokeKey = useRevokeApiKey();
  const regenerateKey = useRegenerateApiKey();
  const reorderKeys = useReorderApiKeys();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKeyResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyResponse | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKeyResponse | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<ApiKeyResponse | null>(null);
  const [bansOpen, setBansOpen] = useState(false);

  const keys = keysQuery.data ?? [];
  // Bans are keyed on the client address, so they are cross-tenant: only a
  // platform admin may see or lift one, and the entry point is hidden for
  // everyone else. The endpoint enforces this too — the gate here is UX.
  const isPlatformAdmin = sessionQuery.data?.isPlatformAdmin ?? false;

  const openShare = (key: ApiKeyResponse) => {
    setRevealedSecret(null);
    setShareTarget(key);
  };

  // A personal key rotates its own credential; a share template has none, so its
  // "rotate" lives in the share dialog (regenerating the link). Only the
  // personal path is offered from the row.
  const rotateWarning = regenerateWarning(true);

  return (
    <Card>
      <CardHeader
        title="API Credentials"
        subtitle="Manage tenant API keys, model access, budgets, and sharing."
        icon={<KeyRound size={16} />}
        action={
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {isPlatformAdmin ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setBansOpen(true)}
                icon={<ShieldOff size={13} />}
              >
                Banned Users
              </Button>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              onClick={() => { setRevealedSecret(null); setCreateOpen(true); }}
              icon={<Plus size={13} />}
            >
              Create Key
            </Button>
          </div>
        }
      />
      <CardBody>
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
          // The key list is the tallest thing on the page; bounding it keeps the
          // page chrome in place and scrolls only the rows, like the sidebar.
          <div className="scroll-region" style={{ maxHeight: "560px", paddingRight: "2px" }}>
          <SortableList
            items={keys}
            label="API credentials"
            disabled={reorderKeys.isPending}
            onReorder={(ids) =>
              reorderKeys.mutate(ids, {
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Could not save the new order.")),
              })
            }
            renderItem={(key) => (
              <div
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
                    <Badge tone={key.revokedAt ? "err" : key.enabled ? "ok" : "warn"}>
                      {key.revokedAt ? "revoked" : key.enabled ? "enabled" : "disabled"}
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
                    <span>
                      {key.keyMode === "share" ? "Total usage " : "Usage "}
                      {compactTokens(key.tokensConsumed)}
                    </span>
                    <span>RPM {limitLabel(key.requestsPerMinute)}</span>
                    <span>Daily {limitLabel(key.dailyTokenLimit)}</span>
                    <span>Monthly {limitLabel(key.monthlyTokenLimit)}</span>
                    <span>One-time {limitLabel(key.lifetimeTokenBudget)}</span>
                    <span>Concurrent {limitLabel(key.maxConcurrentRequests)}</span>
                    <span>
                      {key.modelAccessMode === "blacklist"
                        ? `Blocked ${key.modelList?.length ?? 0}`
                        : `Models ${key.modelList?.length ? key.modelList.length : "All"}`}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>
                  {!key.revokedAt ? (
                    <Switch
                      checked={key.enabled}
                      disabled={updateKey.isPending}
                      id={`api-key-enabled-${key.id}`}
                      label=""
                      aria-label={`${key.enabled ? "Disable" : "Enable"} ${key.label || "API credential"}`}
                      onChange={(enabled) =>
                        updateKey.mutate(
                          { keyId: key.id, request: { enabled } },
                          {
                            onSuccess: () =>
                              toast.success(
                                `${key.label || "API credential"} ${enabled ? "enabled" : "disabled"}`,
                              ),
                            onError: (error) =>
                              toast.error(getErrorMessage(error, "Could not update credential state.")),
                          },
                        )
                      }
                    />
                  ) : null}
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
                  {!key.revokedAt && key.keyMode !== "share" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<RotateCw size={13} />}
                      onClick={() => { setRevealedSecret(null); setRotateTarget(key); }}
                      disabled={regenerateKey.isPending}
                    >
                      Rotate
                    </Button>
                  )}
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
            )}
          />
          </div>
        )}
      </CardBody>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create API Key"
        description="Create a tenant-scoped credential. Choose model access, permissions, limits, and optional blocked client routers."
        size="lg"
      >
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
                toast.success("API key created");
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
        description="Update the key's model access, permissions, limits, share notes, and optional public popup."
        size="lg"
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
                  toast.success("API key updated");
                },
                onError: (error) => toast.error(getErrorMessage(error, "Could not update API key.")),
              },
            );
          }}
        />
      </Dialog>

      {shareTarget ? (
        <ShareManagementDialog
          parent={shareTarget}
          onClose={() => setShareTarget(null)}
          onSecretRevealed={(secret) => {
            // Close the share dialog first: the reveal is its own modal, and a
            // modal must never open on top of another.
            setShareTarget(null);
            setRevealedSecret(secret);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        onConfirm={async () => {
          if (!rotateTarget) return;
          const result = await regenerateKey.mutateAsync({ keyId: rotateTarget.id });
          setRevealedSecret(result.secret);
          toast.success(`Rotated ${rotateTarget.label || rotateTarget.id}.`);
          setRotateTarget(null);
        }}
        title={rotateWarning.title}
        message={rotateWarning.message}
        confirmLabel={rotateWarning.confirmLabel}
        danger
      />

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

      {bansOpen ? <ModelBansDialog onClose={() => setBansOpen(false)} /> : null}

      <ApiKeySecretDialog secret={revealedSecret} onClose={() => setRevealedSecret(null)} />

    </Card>
  );
}
