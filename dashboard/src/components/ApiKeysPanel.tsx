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
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import { compactTokens, limitLabel } from "../shared/display-formatters";
import { useSessionUser } from "../hooks/system";import type { ApiKeyResponse } from "../data/contracts";
import {
  useApiKeys,
  useCreateApiKey,
  useRegenerateApiKey,
  useReorderApiKeys,
  useRevokeApiKey,
  useUpdateApiKey,
} from "../hooks/api-keys";

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
  const [createActions, setCreateActions] = useState<ReactNode>(null);
  const [editActions, setEditActions] = useState<ReactNode>(null);

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
          <div className="flex items-center gap-4">
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
          <div className="scroll-region max-h-280 pr-1">
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
              <div className="api-key-card">
                <div className="min-w-0 flex-1">
                  <div
                    className="flex items-center gap-4 flex-wrap"
                  >
                    <strong className="text-body">
                      {key.label || "Unnamed credential"}
                    </strong>
                    <Badge tone={key.revokedAt ? "err" : key.enabled ? "ok" : "warn"}>
                      {key.revokedAt ? "revoked" : key.enabled ? "enabled" : "disabled"}
                    </Badge>
                    <Badge tone={key.keyMode === "share" ? "accent" : "default"}>
                      {key.keyMode === "share" ? "share template" : "personal"}
                    </Badge>
                    {key.isDefault ? (
                      <Badge tone="warn" title="Required by the gateway. Rotate it; it cannot be deleted.">
                        default · rotate only
                      </Badge>
                    ) : null}
                  </div>
                  <div className="api-key-facts">
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">Created</span>
                      {new Date(key.createdAt).toLocaleDateString()}
                    </span>
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">{key.keyMode === "share" ? "Total usage" : "Usage"}</span>
                      {compactTokens(key.tokensConsumed)}
                    </span>
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">RPM</span>
                      {limitLabel(key.requestsPerMinute)}
                    </span>
                  </div>
                  <div className="api-key-facts">
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">Daily</span>
                      {limitLabel(key.dailyTokenLimit)}
                    </span>
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">Monthly</span>
                      {limitLabel(key.monthlyTokenLimit)}
                    </span>
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">One-time</span>
                      {limitLabel(key.lifetimeTokenBudget)}
                    </span>
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">Concurrent</span>
                      {limitLabel(key.maxConcurrentRequests)}
                    </span>
                    <span className="api-key-pill">
                      <span className="api-key-pill-label">{key.modelAccessMode === "blacklist" ? "Blocked" : "Models"}</span>
                      {key.modelAccessMode === "blacklist"
                        ? (key.modelList?.length ?? 0)
                        : key.modelList?.length ? key.modelList.length : "All"}
                    </span>
                  </div>
                </div>
                <div className="flex gap-3 shrink-0 flex-wrap">
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
                  {!key.revokedAt && !key.isDefault && (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Trash2 size={13} />}
                      onClick={() => setRevokeTarget(key)}
                      disabled={revokeKey.isPending}
                    >
                      Revoke
                    </Button>
                  )}
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
        footer={createActions}
      >
        <ApiKeyForm
          mode="create"
          record={null}
          busy={createKey.isPending}
          onClose={() => setCreateOpen(false)}
          actionsRef={setCreateActions}
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
        footer={editActions}
      >
        <ApiKeyForm
          mode="edit"
          record={editTarget}
          busy={updateKey.isPending}
          onClose={() => setEditTarget(null)}
          actionsRef={setEditActions}
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
