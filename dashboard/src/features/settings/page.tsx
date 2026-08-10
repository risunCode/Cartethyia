/**
 * Settings page — security, runtime toggles, backup/restore and danger zone (REQ-5).
 * Sensitive actions re-confirm the active password via PasswordModal.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, Download, FileJson, KeyRound, ShieldCheck, Trash2, Upload } from "lucide-react";
import { toast } from "../../lib/toast";
import { apiGet, apiPost, apiDownload } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { downloadBlob, readJsonFile } from "../../lib/files";
import { qk } from "../../lib/query-keys";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { PasswordModal } from "../../components/shared";

interface RuntimeSettings {
  proxyAuthMode: "open" | "api_key";
  privacyMode: "masked" | "full";
  trackPayloads: "none" | "bounded";
  trackAssets: "none" | "meta";
  maxFlightsPerIp: number;
  trustProxy: boolean;
  sessionTtlHours: number;
}

interface SettingsResponse {
  settings: {
    hasPassword: boolean;
    passwordVersion: number;
    updatedAt: string;
    runtime: RuntimeSettings;
  };
}

type SensitiveAction = "backup" | "restore" | null;
type DetectedBackupKind = "restore";

export function detectBackupKind(value: unknown): DetectedBackupKind | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = Object.fromEntries(Object.entries(value));
  return candidate.app === "cartethyia" && typeof candidate.tables === "object" && candidate.tables !== null ? "restore" : null;
}

function errorMessage(err: unknown): string {
  return getErrorMessage(err, "Request failed");
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<SensitiveAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [backupIncludeUsage, setBackupIncludeUsage] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreKind, setRestoreKind] = useState<DetectedBackupKind | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reloadTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
  }, []);
  const [maxFlightsDraft, setMaxFlightsDraft] = useState<string | null>(null);
  const [sessionTtlDraft, setSessionTtlDraft] = useState<string | null>(null);

  // Password change form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirmation, setResetConfirmation] = useState("");

  const { data } = useQuery({
    queryKey: qk.settings.all,
    queryFn: () => apiGet<SettingsResponse>("/settings"),
  });

  const patchMutation = useMutation({
    mutationFn: (patch: Partial<RuntimeSettings>) => apiPost<{ ok: boolean }>("/settings", patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings.all }),
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
      reloadTimerRef.current = window.setTimeout(() => { reloadTimerRef.current = null; window.location.reload(); }, 800);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const resetMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>("/settings/reset-all", { password: resetPassword, confirmation: resetConfirmation }),
    onSuccess: () => {
      toast.success("All configuration and runtime data reset");
      setResetPassword("");
      setResetConfirmation("");
      reloadTimerRef.current = window.setTimeout(() => { reloadTimerRef.current = null; window.location.reload(); }, 800);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const patch = (p: Partial<RuntimeSettings>) => patchMutation.mutate(p);
  const settings = data?.settings.runtime;

  const handleRestoreFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setRestoreFile(file);
    setRestoreKind(null);
    if (!file) return;
    try {
      const parsed = await readJsonFile(file);
      const kind = detectBackupKind(parsed);
      if (!kind) throw new Error("Unsupported backup format");
      setRestoreKind(kind);
      toast.success("Cartethyia backup detected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to read backup file");
    }
  };

  // Sensitive action runner (password-gated)
  const runSensitive = async (password: string) => {
    setActionError(null);
    try {
      if (action === "backup") {
        const { blob } = await apiDownload(`/settings/backup${backupIncludeUsage ? "?includeHistory=true" : ""}`, {
          headers: { "x-console-password": password },
        });
        downloadBlob(`cartethyia-backup-${new Date().toISOString().slice(0, 10)}.json`, blob, "application/json");
        toast.success("Backup downloaded");
        setAction(null);
      } else if (action === "restore") {
        if (!restoreFile) throw new Error("choose a backup file first");
        const backup = await readJsonFile(restoreFile);
        await apiPost<{ ok: boolean }>("/settings/restore", { password, backup });
        toast.success("Backup restored");
        setAction(null);
        setRestoreFile(null);
        setRestoreKind(null);
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
    <div className="dashboard-page space-y-4">
      {/* Security — spans full width: most sensitive section, wants room to breathe */}
      <Card>
        <CardHeader
          title="Security"
          sub={data ? `Password version ${data.settings.passwordVersion} · updated ${new Date(data.settings.updatedAt).toLocaleString()}` : undefined}
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
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            disabled={
              !currentPassword || newPassword.length < 5 || newPassword !== confirmPassword || passwordMutation.isPending
            }
            onClick={() => passwordMutation.mutate()}
          >
            <KeyRound size={13} /> {passwordMutation.isPending ? "Changing…" : "Change password"}
          </Button>
        </div>
        {newPassword.length > 0 && newPassword.length < 5 && (
          <p className="mt-2 text-[11px] text-[var(--orange)]">New password must be at least 5 characters.</p>
        )}
      </Card>

      {settings && (
        <Card>
          <CardHeader title="Privacy" icon={ShieldCheck} sub="Payload capture is bounded, redacted, and disabled by default only when explicitly selected." />
          <div className="grid gap-3 sm:grid-cols-3">
            <Label>
              Privacy mode
              <select aria-label="Privacy mode" className="mt-1 h-10 w-full rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--text-1)]" value={settings.privacyMode} onChange={(event) => patch({ privacyMode: event.target.value as RuntimeSettings["privacyMode"] })}>
                <option value="masked">Masked IP (recommended)</option>
                <option value="full">Show full IP</option>
              </select>
            </Label>
            <Label>
              Request payload capture
              <select aria-label="Request payload capture" className="mt-1 h-10 w-full rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--text-1)]" value={settings.trackPayloads} onChange={(event) => patch({ trackPayloads: event.target.value as RuntimeSettings["trackPayloads"] })}>
                <option value="bounded">Bounded debug capture (16 KiB/artifact)</option>
                <option value="none">Disabled</option>
              </select>
            </Label>
            <Label>
              Request assets
              <select aria-label="Request assets" className="mt-1 h-10 w-full rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--text-1)]" value={settings.trackAssets} onChange={(event) => patch({ trackAssets: event.target.value as RuntimeSettings["trackAssets"] })}>
                <option value="meta">Metadata only</option>
                <option value="none">Do not retain asset metadata</option>
              </select>
            </Label>
          </div>
          <p className="mt-3 text-[11px] text-[var(--text-3)]">Bounded capture stores at most 16 KiB per artifact (client request, translated provider request, provider response, and final client response). Credential-like fields are redacted before persistence.</p>
        </Card>
      )}

      {/* Access and runtime limits */}
      {settings && (
        <>
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            <Card className="flex h-full flex-col">
              <CardHeader title="Request Limits" icon={ShieldCheck} />
              <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Max in-flight per IP <span className="font-normal text-[var(--text-3)]">(default 15)</span></Label>
                <Input
                  type="number"
                  min={1}
                  value={maxFlightsDraft ?? String(settings.maxFlightsPerIp)}
                  onFocus={() => setMaxFlightsDraft(String(settings.maxFlightsPerIp))}
                  onChange={(e) => setMaxFlightsDraft(e.target.value)}
                  onBlur={() => {
                    const next = Math.max(1, Math.floor(Number(maxFlightsDraft) || 15));
                    setMaxFlightsDraft(String(next));
                    patch({ maxFlightsPerIp: next });
                  }}
                />
              </div>
              <div>
                <Label>Session TTL (hours) <span className="font-normal text-[var(--text-3)]">(default 24)</span></Label>
                <Input
                  type="number"
                  min={1}
                  max={720}
                  value={sessionTtlDraft ?? String(settings.sessionTtlHours)}
                  onFocus={() => setSessionTtlDraft(String(settings.sessionTtlHours))}
                  onChange={(e) => setSessionTtlDraft(e.target.value)}
                  onBlur={() => {
                    const next = Math.min(720, Math.max(1, Math.floor(Number(sessionTtlDraft) || 1)));
                    setSessionTtlDraft(String(next));
                    patch({ sessionTtlHours: next });
                  }}
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
            </Card>

          {/* Backup & restore */}
          <Card className="flex h-full flex-col">
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
                onChange={(e) => void handleRestoreFileChange(e)}
              />
              <Button variant="secondary" size="sm" className="min-w-0" onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} className="shrink-0" /> <span className="truncate">{restoreFile ? restoreFile.name : "Choose backup file…"}</span>
              </Button>
              <Button variant="secondary" size="sm" disabled={!restoreKind} onClick={() => setAction("restore")}>
                <FileJson size={13} /> Import selected
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-[var(--text-3)]">
              Contains settings (keeps login state), API keys, aliases, combos, access rules, routing and
              accounts. History only with ?includeHistory=true.
            </p>
          </Card>
          </div>

          <Card className="w-full border border-[color-mix(in_srgb,var(--red)_35%,var(--inner-border))] bg-[color-mix(in_srgb,var(--red)_6%,var(--card-bg))]">
            <CardHeader title="Danger Zone" icon={AlertTriangle} iconColor="var(--red)" sub="Permanently remove all configuration and runtime data. This cannot be undone." />
            <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
              <Label>Password<Input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="Current console password" autoComplete="current-password" /></Label>
              <Label>Type <code className="font-mono text-[10px] text-[var(--red)]">RESET ALL DATABASE AND RUNTIME</code><Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} placeholder="Type the confirmation text" spellCheck={false} /></Label>
              <Button variant="danger" disabled={resetMutation.isPending || resetPassword.length === 0 || resetConfirmation !== "RESET ALL DATABASE AND RUNTIME"} onClick={() => resetMutation.mutate()}>
                <Trash2 size={13} /> {resetMutation.isPending ? "Resetting…" : "Reset all data"}
              </Button>
            </div>
            <p className="mt-3 text-[11px] text-[var(--red)]">This resets provider accounts, API keys, routing, aliases, combos, custom providers, request history, and console logs. The application returns to initial setup.</p>
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
