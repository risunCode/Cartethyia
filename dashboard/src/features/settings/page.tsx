/**
 * Settings page — security, runtime toggles, backup/restore and danger zone (REQ-5).
 * Sensitive actions re-confirm the active password via PasswordModal.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent } from "react";
import { Activity, Download, FileJson, KeyRound, ShieldCheck, Trash2, Upload } from "lucide-react";
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
  trackPayloads: "none" | "meta";
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

type SensitiveAction = "backup" | "restore" | "restore-9router" | null;
type DetectedBackupKind = Exclude<SensitiveAction, "backup" | null>;

function detectBackupKind(value: unknown): DetectedBackupKind | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { app?: unknown; tables?: unknown; providerConnections?: unknown; proxyPools?: unknown };
  if (Array.isArray(candidate.providerConnections) && Array.isArray(candidate.proxyPools)) return "restore-9router";
  if (candidate.app === "cartethyia" && typeof candidate.tables === "object" && candidate.tables !== null) return "restore";
  return null;
}

interface NineRouterCompatibilityReport {
  imported: { accounts: number; proxies: number; apiKeys: number; aliases: number; combos: number };
  skipped: {
    unsupportedProviders: Array<{ provider: string; count: number }>;
    invalidConnections: Array<{ provider: string; name: string; reason: string }>;
    invalidProxies: Array<{ name: string; reason: string }>;
    unsupportedNodes: Array<{ id: string; name: string; reason: string }>;
    droppedFields: Array<{ field: string; count: number }>;
  };
  warnings: string[];
}

function compatibilitySummary(report: NineRouterCompatibilityReport): string {
  const imported = `Imported ${report.imported.accounts} accounts, ${report.imported.proxies} proxies, ${report.imported.apiKeys} API keys, ${report.imported.aliases} aliases, ${report.imported.combos} combos`;
  const skippedProviders = report.skipped.unsupportedProviders.reduce((total, item) => total + item.count, 0);
  const skipped = skippedProviders + report.skipped.invalidConnections.length + report.skipped.invalidProxies.length + report.skipped.unsupportedNodes.length;
  if (skipped === 0) return `${imported}.`;
  const providerDetails = report.skipped.unsupportedProviders.map((item) => `${item.provider} (${item.count})`).join(", ");
  const categories = [
    providerDetails ? `unsupported providers: ${providerDetails}` : "",
    report.skipped.invalidConnections.length > 0 ? `invalid connections: ${report.skipped.invalidConnections.length}` : "",
    report.skipped.invalidProxies.length > 0 ? `invalid proxies: ${report.skipped.invalidProxies.length}` : "",
    report.skipped.unsupportedNodes.length > 0 ? `provider nodes: ${report.skipped.unsupportedNodes.length}` : "",
  ].filter(Boolean).join(" · ");
  return `${imported}. Skipped ${skipped}: ${categories}.`;
}

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
  const [restoreKind, setRestoreKind] = useState<DetectedBackupKind | null>(null);
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

  const handleRestoreFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setRestoreFile(file);
    setRestoreKind(null);
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const kind = detectBackupKind(parsed);
      if (!kind) throw new Error("Unsupported backup format");
      setRestoreKind(kind);
      toast.success(kind === "restore-9router" ? "9Router backup detected" : "Cartethyia backup detected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to read backup file");
    }
  };

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
      } else if (action === "restore" || action === "restore-9router") {
        if (!restoreFile) throw new Error("choose a backup file first");
        const backup: unknown = JSON.parse(await restoreFile.text());
        if (action === "restore-9router") {
          const response = await apiPost<{ ok: boolean; compatibility: NineRouterCompatibilityReport }>("/settings/restore/9router", { password, backup });
          toast.success("9Router backup imported", { description: compatibilitySummary(response.compatibility) });
        } else {
          await apiPost<{ ok: boolean }>("/settings/restore", { password, backup });
          toast.success("Backup restored");
        }
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
    "restore-9router": {
      title: "Import 9Router Backup",
      description: `Convert supported data from "${restoreFile?.name ?? "the selected file"}" into Cartethyia. Unsupported providers and nodes are skipped. Existing imported configuration is replaced.`,
    },
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Settings</h1>
        <p className="text-xs text-[var(--text-2)]">Runtime configuration — changes apply without restart.</p>
      </div>

      {/* Security — spans full width: most sensitive section, wants room to breathe */}
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

      {/* Tracking + Access - side by side on desktop, System-Settings-panel style */}
      {settings && (
        <>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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

          <Card className="lg:h-fit">
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
        </div>


          {/* Backup & restore - spans full width again below the two-column row */}
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
                onChange={(e) => void handleRestoreFileChange(e)}
              />
              <Button variant="secondary" size="sm" className="min-w-0" onClick={() => fileInputRef.current?.click()}>
                <Upload size={13} className="shrink-0" /> <span className="truncate">{restoreFile ? restoreFile.name : "Choose backup file…"}</span>
              </Button>
              <Button variant="secondary" size="sm" disabled={!restoreKind} onClick={() => setAction(restoreKind)}>
                <FileJson size={13} /> Import selected
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
