/**
 * Settings page — security, runtime toggles, backup/restore and danger zone (REQ-5).
 * Sensitive actions re-confirm the active password via PasswordModal.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Activity, Download, KeyRound, ShieldCheck, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiGet, apiPost } from "../../lib/api";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label } from "../../components/ui/input";
import { Select } from "../../components/ui/tabs";
import { ConfirmDialog } from "../../components/shared";
import { Switch } from "../../components/ui/switch";
import { PasswordModal } from "../../components/shared";

interface RuntimeSettings {
  proxyAuthMode: "open" | "api_key";
  trackPayloads: "none" | "meta" | "store";
  trackAssets: "none" | "meta" | "store";
  logRetentionDays: number;
  assetRetentionDays: number;
  maxFlightsPerIp: number;
  trustProxy: boolean;
  cacheMarkersEnabled: boolean;
  sessionTtlHours: number;
}

interface SettingsResponse {
  hasPassword: boolean;
  passwordVersion: number;
  updatedAt: string;
  settings: RuntimeSettings;
}

type SensitiveAction = "backup" | "restore" | null;

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "request failed";
}

function PurgeStoredButton() {
  const [confirm, setConfirm] = useState(false);
  const mut = useMutation({
    mutationFn: () => apiPost<{ ok: boolean; details: number; assets: number; toolCalls: number }>("/usage/purge-stored", {}),
    onSuccess: (res) => {
      toast.success(`Purged: ${res.details} details, ${res.assets} assets, ${res.toolCalls} tool calls`);
      setConfirm(false);
    },
    onError: () => toast.error("Failed to purge stored data"),
  });
  return (
    <>
      <Button variant="secondary" size="sm" className="text-[#ff453a]" onClick={() => setConfirm(true)}>
        <Trash2 size={13} /> Purge all
      </Button>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => mut.mutate()}
        title="Purge stored data?"
        message="This permanently deletes all stored request payloads, tool call details, and asset metadata from the database. Usage history (counts/tokens) is preserved."
        danger
        confirmLabel="Purge"
      />
    </>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<SensitiveAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [backupIncludeUsage, setBackupIncludeUsage] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password change form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsResponse>("/settings"),
  });

  const patchMutation = useMutation({
    mutationFn: (patch: Partial<RuntimeSettings>) => apiPost<{ ok: boolean }>("/settings", patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const passwordMutation = useMutation({
    mutationFn: () =>
      apiPost<{ ok: boolean }>("/settings/password", { currentPassword, newPassword, confirmPassword }),
    onSuccess: () => {
      toast.success("Password changed — you have been signed out");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // pv bump invalidates this session; the 401 bridge redirects to login.
      setTimeout(() => window.location.reload(), 800);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const patch = (p: Partial<RuntimeSettings>) => patchMutation.mutate(p);
  const settings = data?.settings;

  // Sensitive action runner (password-gated) 
  const runSensitive = async (password: string) => {
    setActionError(null);
    try {
      if (action === "backup") {
        const res = await fetch(`/console/api/settings/backup${backupIncludeUsage ? "?includeHistory=true" : ""}`, {
          credentials: "same-origin",
          headers: { "x-console-password": password },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `backup failed (${res.status})`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `cartethyia-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        toast.success("Backup downloaded");
        setAction(null);
      } else if (action === "restore") {
        if (!restoreFile) throw new Error("choose a backup file first");
        const backup: unknown = JSON.parse(await restoreFile.text());
        await apiPost<{ ok: boolean }>("/settings/restore", { password, backup });
        toast.success("Backup restored");
        setAction(null);
        setRestoreFile(null);
        void queryClient.invalidateQueries();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "action failed");
    }
  };

  const actionMeta: Record<Exclude<SensitiveAction, null>, { title: string; description: string }> = {
    backup: {
      title: "Download Backup",
      description: "Export settings, keys, combos, pools, access rules and accounts. Usage history is excluded by default (large).",
    },
    restore: {
      title: "Restore Backup",
      description: `Replace the current configuration with "${restoreFile?.name ?? "the selected file"}". This overwrites settings, keys and accounts.`,
    },
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Settings</h1>
        <p className="text-xs text-[var(--text-2)]">Runtime configuration — changes apply without restart.</p>
      </div>

      {/* Security */}
      <Card>
        <CardHeader
          title="Security"
          sub={data ? `Password version ${data.passwordVersion} · updated ${new Date(data.updatedAt).toLocaleString()}` : undefined}
        >
          <Badge tone="ok">
            <ShieldCheck size={11} className="mr-1" /> argon2id
          </Badge>
        </CardHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Current password</Label>
            <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          </div>
          <div>
            <Label>New password</Label>
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </div>
          <div>
            <Label>Confirm new password</Label>
            <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={
              !currentPassword || newPassword.length < 8 || newPassword !== confirmPassword || passwordMutation.isPending
            }
            onClick={() => passwordMutation.mutate()}
          >
            <KeyRound size={13} /> {passwordMutation.isPending ? "Changing…" : "Change password"}
          </Button>
        </div>
        {newPassword.length > 0 && newPassword.length < 8 && (
          <p className="mt-2 text-[11px] text-[var(--orange)]">New password must be at least 8 characters.</p>
        )}
      </Card>

      {/* Tracking + Access */}
      {settings && (
        <>
          <Card>
            <CardHeader title="Logging & Retention" icon={Activity} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">Payloads</div>
                </div>
                <Select
                  ariaLabel="Track payloads"
                  value={settings.trackPayloads}
                  onChange={(v) => patch({ trackPayloads: v as RuntimeSettings["trackPayloads"] })}
                  options={[
                    { value: "none", label: "Off" },
                    { value: "meta", label: "Meta only" },
                    { value: "store", label: "Store" },
                  ]}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">Assets</div>
                </div>
                <Select
                  ariaLabel="Track assets"
                  value={settings.trackAssets}
                  onChange={(v) => patch({ trackAssets: v as RuntimeSettings["trackAssets"] })}
                  options={[
                    { value: "none", label: "Off" },
                    { value: "meta", label: "Meta only" },
                    { value: "store", label: "Store" },
                  ]}
                />
              </div>
              <div>
                <Label>Log retention (days)</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={String(settings.logRetentionDays)}
                  onBlur={(e) => patch({ logRetentionDays: Math.min(365, Math.max(1, Math.floor(Number(e.target.value) || 14))) })}
                  onChange={() => undefined}
                />
              </div>
              <div>
                <Label>Asset retention (days)</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={String(settings.assetRetentionDays)}
                  onBlur={(e) => patch({ assetRetentionDays: Math.min(365, Math.max(1, Math.floor(Number(e.target.value) || 7))) })}
                  onChange={() => undefined}
                />
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-xl border border-dashed border-[var(--inner-border)] p-3">
              <div>
                <div className="text-xs font-semibold">Stored payloads & assets</div>
                <div className="text-[11px] text-[var(--text-3)]">Purge all stored request details, tool calls, and asset files from the database.</div>
              </div>
              <PurgeStoredButton />
            </div>
          </Card>

          <Card>
            <CardHeader title="Request Limits" icon={ShieldCheck} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Max in-flight per IP</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={String(settings.maxFlightsPerIp)}
                  onBlur={(e) => patch({ maxFlightsPerIp: Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 20))) })}
                  onChange={() => undefined}
                />
              </div>
              <div>
                <Label>Session TTL (hours)</Label>
                <Input
                  type="number"
                  min={1}
                  max={720}
                  value={String(settings.sessionTtlHours)}
                  onBlur={(e) => patch({ sessionTtlHours: Math.min(720, Math.max(1, Math.floor(Number(e.target.value) || 12))) })}
                  onChange={() => undefined}
                />
              </div>
              <label className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">Trust proxy headers</div>
                  <div className="text-[11px] text-[var(--text-3)]">Use X-Forwarded-For for client IPs.</div>
                </div>
                <Switch checked={settings.trustProxy} onChange={(v) => patch({ trustProxy: v })} label="Trust proxy" />
              </label>
            </div>
            <div className="mt-4 border-t border-[var(--inner-border)] pt-4">
              <CardHeader title="Response Cache" />
              <label className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold">Cache markers</div>
                  <div className="text-[11px] text-[var(--text-3)]">Emit cache-control hints on responses.</div>
                </div>
                <Switch checked={settings.cacheMarkersEnabled} onChange={(v) => patch({ cacheMarkersEnabled: v })} label="Cache markers" />
              </label>
            </div>
          </Card>

          {/* Backup & restore */}
          <Card>
            <CardHeader title="Backup & Restore" icon={Download} sub="DB-only JSON snapshot; disk assets are not included." />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAction("backup")}>
                <Download size={13} /> Download backup
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
              />
              <Button variant="secondary" size="sm" className="min-w-0" onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} className="shrink-0" /> <span className="truncate">{restoreFile ? restoreFile.name : "Choose backup file…"}</span>
              </Button>
              <Button variant="secondary" size="sm" disabled={!restoreFile} onClick={() => setAction("restore")}>
                Restore…
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-[var(--text-3)]">
              Contains settings (keeps login state), API keys, aliases, combos, access rules, routing and
              accounts. History only with ?includeHistory=true.
            </p>
          </Card>
        </>
      )}

      <PasswordModal
        open={action !== null}
        onClose={() => {
          setAction(null);
          setActionError(null);
        }}
        onSubmit={(password) => void runSensitive(password)}
        title={action ? actionMeta[action].title : ""}
        description={action ? actionMeta[action].description : ""}
        error={actionError}
      >
        {action === "backup" && (
          <label className="mb-3 flex items-center gap-2 text-xs text-[var(--text-2)]">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--accent)]"
              checked={backupIncludeUsage}
              onChange={(e) => setBackupIncludeUsage(e.target.checked)}
            />
            Include usage history (large)
          </label>
        )}
      </PasswordModal>
    </div>
  );
}
