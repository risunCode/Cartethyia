/** Runtime settings, backup, and operational controls backed by daemon V2 admin routes. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, DatabaseBackup, Download, RefreshCw, RotateCcw, Save, Settings2, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label } from "../../components/ui/input";
import { StatePanel } from "../../components/ui/state";
import { daemonDelete, daemonGet, daemonPatch, daemonPost } from "../../lib/daemon-api";
import { getErrorMessage } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { toast } from "../../lib/toast";
import {
  downloadBackup,
  hasAdminScope,
  parseAdminScopes,
  parseBackupList,
  parseRestoreResult,
  parseRuntimeSettings,
  parseToolResult,
  validateProbeUrl,
  type BackupRecord,
  type RuntimeSettings,
} from "./operations";

const backupKey = qk.backups.all;
const toolsKey = qk.tools.all;
const sessionKey = ["admin-session"] as const;
const DESTRUCTIVE_CONFIRMATION = "This operation changes daemon state. Continue?";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function operationError(error: unknown, fallback: string): string {
  return getErrorMessage(error, fallback);
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [restoreFailure, setRestoreFailure] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const probeInputRef = useRef<HTMLInputElement>(null);
  const [cacheName, setCacheName] = useState("catalog");
  const [reindexTarget, setReindexTarget] = useState("catalog");

  const settingsQuery = useQuery({
    queryKey: qk.settings.all,
    queryFn: async () => parseRuntimeSettings(await daemonGet<unknown>("/settings")),
  });
  const backupsQuery = useQuery({
    queryKey: backupKey,
    queryFn: async () => parseBackupList(await daemonGet<unknown>("/backups")),
  });
  const sessionQuery = useQuery({
    queryKey: sessionKey,
    queryFn: () => daemonGet<unknown>("/auth/session"),
    staleTime: 30_000,
  });
  const scopes = parseAdminScopes(sessionQuery.data);
  const canConfig = hasAdminScope(scopes, "admin:config");
  const canBackups = hasAdminScope(scopes, "admin:backups");
  const canCache = hasAdminScope(scopes, "admin:cache");
  const canHealth = hasAdminScope(scopes, "admin:health");
  const canLifecycle = hasAdminScope(scopes, "admin:lifecycle");
  const scopeKnown = !sessionQuery.isPending && !sessionQuery.isError;

  const patchMutation = useMutation({
    mutationFn: (patch: Partial<RuntimeSettings>) => daemonPatch<unknown>("/settings", patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings.all }),
    onError: (error) => toast.error(operationError(error, "Unable to update settings")),
  });
  const resetMutation = useMutation({
    mutationFn: () => daemonPost<unknown>("/settings"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.settings.all });
      toast.success("Runtime settings reset");
    },
    onError: (error) => toast.error(operationError(error, "Unable to reset settings")),
  });
  const createBackupMutation = useMutation({
    mutationFn: (includesDatabase: boolean) => daemonPost<unknown>("/backups", { includesDatabase }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupKey });
      toast.success("Backup created");
    },
    onError: (error) => toast.error(operationError(error, "Unable to create backup")),
  });
  const deleteBackupMutation = useMutation({
    mutationFn: (id: string) => daemonDelete<unknown>(`/backups/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupKey });
      toast.success("Backup deleted");
    },
    onError: (error) => toast.error(operationError(error, "Unable to delete backup")),
  });
  const restoreMutation = useMutation({
    mutationFn: async ({ id, dryRun, includeDatabase }: { id: string; dryRun: boolean; includeDatabase: boolean }) =>
      parseRestoreResult(await daemonPost<unknown>(`/backups/${encodeURIComponent(id)}/restore`, { dryRun, includeDatabase })),
    onSuccess: (result) => {
      setRestoreFailure(null);
      void queryClient.invalidateQueries({ queryKey: backupKey });
      if (result.applied) void queryClient.invalidateQueries({ queryKey: qk.settings.all });
      toast.success(result.applied ? "Backup restored" : "Dry run completed");
    },
    onError: (error) => {
      const message = operationError(error, "Backup restore failed");
      setRestoreFailure(message);
      toast.error(message);
    },
  });
  const toolMutation = useMutation({
    mutationFn: async (input: { route: string; body?: unknown }) => parseToolResult(await daemonPost<unknown>(input.route, input.body)),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: toolsKey });
      void queryClient.invalidateQueries({ queryKey: qk.settings.all });
      toast.success(result.detail ?? "Operation completed");
    },
    onError: (error) => toast.error(operationError(error, "Operation unavailable")),
  });

  const settings = settingsQuery.data;
  const settingsUnavailable = settingsQuery.isError && !settings;
  const scopeUnavailable = !scopeKnown;
  const settingsPending = patchMutation.isPending || resetMutation.isPending;
  const backupPending = createBackupMutation.isPending || deleteBackupMutation.isPending || restoreMutation.isPending || downloadingId !== null;
  const toolsPending = toolMutation.isPending;

  const patch = (value: Partial<RuntimeSettings>) => patchMutation.mutate(value);
  const reset = () => {
    if (window.confirm(DESTRUCTIVE_CONFIRMATION)) resetMutation.mutate();
  };
  const download = async (backup: BackupRecord) => {
    setDownloadingId(backup.id);
    try {
      const artifact = await downloadBackup(backup.id);
      const url = URL.createObjectURL(artifact.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(operationError(error, "Backup download failed"));
    } finally {
      setDownloadingId(null);
    }
  };
  const restore = (backup: BackupRecord, dryRun: boolean) => {
    if (!dryRun && !window.confirm(DESTRUCTIVE_CONFIRMATION)) return;
    setRestoreFailure(null);
    restoreMutation.mutate({ id: backup.id, dryRun, includeDatabase: backup.includesDatabase });
  };
  const remove = (backup: BackupRecord) => {
    if (window.confirm("Delete this backup permanently?")) deleteBackupMutation.mutate(backup.id);
  };
  const disabledByScope = (allowed: boolean) => scopeUnavailable || !allowed;

  return (
    <div className="dashboard-page space-y-4">
      <Card>
        <CardHeader title="Runtime settings" icon={ShieldCheck} sub="Daemon V2 admin runtime configuration." />
        {settingsUnavailable ? (
          <StatePanel kind="error" title="Runtime settings unavailable" description={operationError(settingsQuery.error, "The daemon did not provide runtime settings.")} />
        ) : settings ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Label>Environment<Input value={settings.environment} readOnly /></Label>
            <Label>
              Log level
              <select aria-label="Log level" disabled={disabledByScope(canConfig) || settingsPending} className="mt-1 h-10 w-full rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--text-1)]" value={settings.logLevel} onChange={(event) => patch({ logLevel: event.target.value })}>
                <option value="trace">Trace</option><option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option>
              </select>
            </Label>
            <Label>Listen address<Input value={settings.listenAddr} disabled={disabledByScope(canConfig) || settingsPending} onChange={(event) => patch({ listenAddr: event.target.value })} /></Label>
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button type="button" variant="outline" onClick={reset} disabled={disabledByScope(canConfig) || settingsPending}><RotateCcw size={14} aria-hidden="true" />{resetMutation.isPending ? "Resetting…" : "Reset runtime settings"}</Button>
              {scopeUnavailable && <span className="text-xs text-[var(--text-3)]">Permission state unavailable.</span>}
            </div>
          </div>
        ) : <p className="text-sm text-[var(--text-3)]">Loading runtime settings…</p>}
      </Card>

      <Card>
        <CardHeader title="Backups" icon={DatabaseBackup} sub="Opaque daemon artifacts; contents are never parsed in the browser." />
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => createBackupMutation.mutate(false)} disabled={disabledByScope(canBackups) || backupPending}><Save size={14} aria-hidden="true" />{createBackupMutation.isPending ? "Creating…" : "Create backup"}</Button>
          <Button type="button" variant="secondary" onClick={() => createBackupMutation.mutate(true)} disabled={disabledByScope(canBackups) || backupPending}>Create with database</Button>
        </div>
        {backupsQuery.isError ? <StatePanel kind="error" title="Backups unavailable" description={operationError(backupsQuery.error, "The daemon did not provide backups.")} /> : backupsQuery.data?.length === 0 ? <StatePanel kind="empty" title="No backups" description="Create a backup to make a restore point." /> : (
          <div className="space-y-2" aria-live="polite">
            {backupsQuery.data?.map((backup) => (
              <div key={backup.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2">
                <div><div className="text-xs font-semibold">{backup.createdAt}</div><div className="text-[11px] text-[var(--text-3)]">{formatBytes(backup.sizeBytes)}{backup.includesDatabase ? " · includes database" : ""}</div></div>
                <div className="flex flex-wrap gap-1.5">
                  <Button type="button" size="sm" variant="ghost" onClick={() => void download(backup)} disabled={disabledByScope(canBackups) || backupPending}><Download size={13} aria-hidden="true" />{downloadingId === backup.id ? "Downloading…" : "Download"}</Button>
                  <Button type="button" size="sm" variant="secondary" onClick={() => restore(backup, true)} disabled={disabledByScope(canBackups) || backupPending}>Dry run</Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => restore(backup, false)} disabled={disabledByScope(canBackups) || backupPending}>{restoreMutation.isPending ? "Restoring…" : "Restore"}</Button>
                  <Button type="button" size="sm" variant="danger" onClick={() => remove(backup)} disabled={disabledByScope(canBackups) || backupPending}><Trash2 size={13} aria-hidden="true" />Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {restoreFailure && <p role="alert" className="mt-3 text-xs text-[var(--red)]">Restore failed: {restoreFailure}</p>}
      </Card>

      <Card>
        <CardHeader title="Operational tools" icon={Wrench} sub="Dangerous actions are scoped, confirmed, and serialized." />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] p-3">
            <div className="text-xs font-semibold">Cache and reindex</div>
            <div className="flex flex-wrap gap-2"><select aria-label="Cache name" className="h-9 rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-2 text-xs" value={cacheName} onChange={(event) => setCacheName(event.target.value)} disabled={toolsPending || disabledByScope(canCache)}><option value="catalog">Catalog</option><option value="accounts">Accounts</option><option value="proxies">Proxies</option><option value="telemetry">Telemetry</option></select><Button type="button" size="sm" onClick={() => toolMutation.mutate({ route: `/tools/cache/${cacheName}` })} disabled={toolsPending || disabledByScope(canCache)}><RefreshCw size={13} aria-hidden="true" />Flush cache</Button></div>
            <div className="flex flex-wrap gap-2"><select aria-label="Reindex target" className="h-9 rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-2 text-xs" value={reindexTarget} onChange={(event) => setReindexTarget(event.target.value)} disabled={toolsPending || disabledByScope(canHealth)}><option value="catalog">Catalog</option><option value="accounts">Accounts</option></select><Button type="button" size="sm" variant="secondary" onClick={() => toolMutation.mutate({ route: "/tools/reindex", body: { target: reindexTarget } })} disabled={toolsPending || disabledByScope(canHealth)}>Reindex</Button></div>
          </div>
          <div className="space-y-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] p-3">
            <div className="text-xs font-semibold">Connectivity probe</div>
            <Label>HTTP URL<Input ref={probeInputRef} disabled={toolsPending || disabledByScope(canHealth)} placeholder="https://service.example/health" /></Label>
            <Button type="button" size="sm" variant="secondary" disabled={toolsPending || disabledByScope(canHealth)} onClick={() => {
              try {
                const url = validateProbeUrl(probeInputRef.current?.value ?? "");
                toolMutation.mutate({ route: "/tools/probe", body: { url, method: "GET" } }, { onSettled: () => { if (probeInputRef.current) probeInputRef.current.value = ""; } });
              } catch (error) {
                toast.error(operationError(error, "Probe URL is invalid"));
                if (probeInputRef.current) probeInputRef.current.value = "";
              }
            }}><RefreshCw size={13} aria-hidden="true" />{toolsPending ? "Probing…" : "Probe"}</Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] p-3 lg:col-span-2"><div><div className="text-xs font-semibold">Restart daemon</div><p className="text-[11px] text-[var(--text-3)]">Active requests may be interrupted.</p></div><Button type="button" variant="danger" onClick={() => { if (window.confirm(DESTRUCTIVE_CONFIRMATION)) toolMutation.mutate({ route: "/tools/restart" }); }} disabled={toolsPending || disabledByScope(canLifecycle)}><RotateCcw size={13} aria-hidden="true" />{toolsPending ? "Restarting…" : "Restart"}</Button></div>
        </div>
        {scopeUnavailable && <p className="mt-3 text-xs text-[var(--text-3)]">Operational controls are unavailable until the daemon session scope is known.</p>}
      </Card>

      <Card className="flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5 text-[var(--orange)]" aria-hidden="true" /><p className="text-xs text-[var(--text-2)]">Credentials, cookies, prompts, provider responses, and raw backup contents are never submitted to or retained by these controls.</p><Settings2 size={15} className="ml-auto text-[var(--text-3)]" aria-hidden="true" /></Card>
    </div>
  );
}
