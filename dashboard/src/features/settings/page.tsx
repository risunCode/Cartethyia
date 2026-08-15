/* @jsxImportSource solid-js */

import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { AlertTriangle, DatabaseBackup, Download, RefreshCw, RotateCcw, Save, Settings2, ShieldCheck, Trash2, Wrench } from "lucide-solid";
import { For, Show, createSignal } from "solid-js";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";
import { Dropdown } from "../../components/ui/dropdown";
import { Input, Label } from "../../components/ui/input";
import { StatePanel } from "../../components/ui/state";
import { Switch } from "../../components/ui/switch";
import { consoleDelete, consoleGet, consolePatch, consolePost } from "../../lib/console-api";
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
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;

type Confirmation = {
  message: string;
  confirm: () => void;
};

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function operationError(error: unknown, fallback: string): string {
  return getErrorMessage(error, fallback);
}

function SelectField(props: { label: string; value: string; options: readonly string[]; disabled: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Label>
      {props.label}
      <Dropdown
        open={open()}
        onClose={() => setOpen(false)}
        onOpenChange={setOpen}
        id={`settings-${props.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        ariaLabel={props.label}
        trigger={(trigger) => (
          <button
            ref={trigger.ref}
            type="button"
            disabled={props.disabled}
            aria-expanded={trigger["aria-expanded"]}
            aria-haspopup={trigger["aria-haspopup"]}
            aria-controls={trigger["aria-controls"]}
            onClick={trigger.onClick}
            class="mt-1 flex h-10 w-full items-center justify-between rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-3 text-left text-sm text-[var(--text-1)] disabled:pointer-events-none disabled:opacity-50"
          >
            <span>{props.value}</span><span aria-hidden="true">▾</span>
          </button>
        )}
      >
        <For each={props.options}>
          {(option) => (
            <button
              type="button"
              role="menuitem"
              class="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-[var(--text-1)] hover:bg-[var(--hover)]"
              onClick={() => { props.onChange(option); setOpen(false); }}
            >
              {option}
            </button>
          )}
        </For>
      </Dropdown>
    </Label>
  );
}

/** Runtime settings, backup, and operational controls backed by daemon V2 admin routes. */
export function SettingsPage() {
  const queryClient = useQueryClient();
  const [restoreFailure, setRestoreFailure] = createSignal<string | null>(null);
  const [downloadingId, setDownloadingId] = createSignal<string | null>(null);
  const [cacheName, setCacheName] = createSignal("catalog");
  const [reindexTarget, setReindexTarget] = createSignal("catalog");
  const [probeInput, setProbeInput] = createSignal<HTMLInputElement>();
  const [confirmation, setConfirmation] = createSignal<Confirmation | null>(null);

  const settingsQuery = useQuery(() => ({
    queryKey: qk.settings.all,
    queryFn: async () => parseRuntimeSettings(await consoleGet<unknown>("/settings")),
  }));
  const backupsQuery = useQuery(() => ({
    queryKey: backupKey,
    queryFn: async () => parseBackupList(await consoleGet<unknown>("/backups")),
  }));
  const sessionQuery = useQuery(() => ({
    queryKey: sessionKey,
    queryFn: () => consoleGet<unknown>("/auth/session"),
    staleTime: 30_000,
  }));
  const scopes = () => parseAdminScopes(sessionQuery.data);
  const canConfig = () => hasAdminScope(scopes(), "admin:config");
  const canBackups = () => hasAdminScope(scopes(), "admin:backups");
  const canCache = () => hasAdminScope(scopes(), "admin:cache");
  const canHealth = () => hasAdminScope(scopes(), "admin:health");
  const canLifecycle = () => hasAdminScope(scopes(), "admin:lifecycle");
  const scopeKnown = () => !sessionQuery.isPending && !sessionQuery.isError;

  const patchMutation = useMutation(() => ({
    mutationFn: (patch: Partial<RuntimeSettings>) => consolePatch<unknown>("/settings", patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: qk.settings.all }),
    onError: (error) => toast.error(operationError(error, "Unable to update settings")),
  }));
  const resetMutation = useMutation(() => ({
    mutationFn: () => consolePost<unknown>("/settings"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.settings.all });
      toast.success("Runtime settings reset");
    },
    onError: (error) => toast.error(operationError(error, "Unable to reset settings")),
  }));
  const createBackupMutation = useMutation(() => ({
    mutationFn: (includesDatabase: boolean) => consolePost<unknown>("/backups", { includesDatabase }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupKey });
      toast.success("Backup created");
    },
    onError: (error) => toast.error(operationError(error, "Unable to create backup")),
  }));
  const deleteBackupMutation = useMutation(() => ({
    mutationFn: (id: string) => consoleDelete<unknown>(`/backups/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: backupKey });
      toast.success("Backup deleted");
    },
    onError: (error) => toast.error(operationError(error, "Unable to delete backup")),
  }));
  const restoreMutation = useMutation(() => ({
    mutationFn: async ({ id, dryRun, includeDatabase }: { id: string; dryRun: boolean; includeDatabase: boolean }) =>
      parseRestoreResult(await consolePost<unknown>(`/backups/${encodeURIComponent(id)}/restore`, { dryRun, includeDatabase })),
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
  }));
  const toolMutation = useMutation(() => ({
    mutationFn: async (input: { route: string; body?: unknown }) => parseToolResult(await consolePost<unknown>(input.route, input.body)),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: toolsKey });
      void queryClient.invalidateQueries({ queryKey: qk.settings.all });
      toast.success(result.detail ?? "Operation completed");
    },
    onError: (error) => toast.error(operationError(error, "Operation unavailable")),
  }));

  const settingsPending = () => patchMutation.isPending || resetMutation.isPending;
  const backupPending = () => createBackupMutation.isPending || deleteBackupMutation.isPending || restoreMutation.isPending || downloadingId() !== null;
  const toolsPending = () => toolMutation.isPending;
  const disabledByScope = (allowed: boolean) => !scopeKnown() || !allowed;
  const requestConfirmation = (message: string, confirm: () => void) => setConfirmation({ message, confirm });
  const acceptConfirmation = () => {
    const action = confirmation();
    setConfirmation(null);
    action?.confirm();
  };
  const patch = (value: Partial<RuntimeSettings>) => patchMutation.mutate(value);
  const reset = () => requestConfirmation(DESTRUCTIVE_CONFIRMATION, () => resetMutation.mutate());
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
    const execute = () => {
      setRestoreFailure(null);
      restoreMutation.mutate({ id: backup.id, dryRun, includeDatabase: backup.includesDatabase });
    };
    if (dryRun) execute();
    else requestConfirmation(DESTRUCTIVE_CONFIRMATION, execute);
  };
  const remove = (backup: BackupRecord) => requestConfirmation("Delete this backup permanently?", () => deleteBackupMutation.mutate(backup.id));
  const probe = () => {
    try {
      const url = validateProbeUrl(probeInput()?.value ?? "");
      toolMutation.mutate({ route: "/tools/probe", body: { url, method: "GET" } }, { onSettled: () => { const input = probeInput(); if (input) input.value = ""; } });
    } catch (error) {
      toast.error(operationError(error, "Probe URL is invalid"));
      const input = probeInput();
      if (input) input.value = "";
    }
  };

  return (
    <>
      <div class="dashboard-page space-y-4">
        <Card>
          <CardHeader title="Runtime settings" icon={ShieldCheck} sub="Daemon V2 admin runtime configuration." />
          <Show when={!settingsQuery.isError && settingsQuery.data} fallback={<Show when={settingsQuery.isError} fallback={<p class="text-sm text-[var(--text-3)]">Loading runtime settings…</p>}><StatePanel kind="error" title="Runtime settings unavailable" description={operationError(settingsQuery.error, "The daemon did not provide runtime settings.")} /></Show>}>
            {(settings) => <div class="grid gap-3 sm:grid-cols-2">
              <Label>Environment<Input value={settings().environment} readOnly /></Label>
              <SelectField label="Log level" value={settings().logLevel} options={LOG_LEVELS} disabled={disabledByScope(canConfig()) || settingsPending()} onChange={(logLevel) => patch({ logLevel })} />
              <Label>Listen address<Input value={settings().listenAddr} disabled={disabledByScope(canConfig()) || settingsPending()} onChange={(event) => patch({ listenAddr: event.currentTarget.value })} /></Label>
              <Show when={Object.keys(settings().flags).length > 0}>
                <div class="space-y-2 sm:col-span-2">
                  <div class="text-xs font-semibold text-[var(--text-2)]">Runtime toggles</div>
                  <For each={Object.entries(settings().flags)}>
                    {([name, enabled]) => <div class="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--inner-border)] px-3 py-2"><span class="text-xs text-[var(--text-1)]">{name}</span><Switch checked={enabled} label={`Toggle ${name}`} disabled={disabledByScope(canConfig()) || settingsPending()} onChange={(next) => patch({ flags: { ...settings().flags, [name]: next } })} /></div>}
                  </For>
                </div>
              </Show>
              <div class="flex items-end gap-2 sm:col-span-2">
                <Button type="button" variant="outline" onClick={reset} disabled={disabledByScope(canConfig()) || settingsPending()}><RotateCcw size={14} aria-hidden="true" />{resetMutation.isPending ? "Resetting…" : "Reset runtime settings"}</Button>
                <Show when={!scopeKnown()}><span class="text-xs text-[var(--text-3)]">Permission state unavailable.</span></Show>
              </div>
            </div>}
          </Show>
        </Card>

        <Card>
          <CardHeader title="Backups" icon={DatabaseBackup} sub="Opaque daemon artifacts; contents are never parsed in the browser." />
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => createBackupMutation.mutate(false)} disabled={disabledByScope(canBackups()) || backupPending()}><Save size={14} aria-hidden="true" />{createBackupMutation.isPending ? "Creating…" : "Create backup"}</Button>
            <Button type="button" variant="secondary" onClick={() => createBackupMutation.mutate(true)} disabled={disabledByScope(canBackups()) || backupPending()}>Create with database</Button>
          </div>
          <Show when={!backupsQuery.isError} fallback={<StatePanel kind="error" title="Backups unavailable" description={operationError(backupsQuery.error, "The daemon did not provide backups.")} />}>
            <Show when={(backupsQuery.data?.length ?? 0) > 0} fallback={<StatePanel kind="empty" title="No backups" description="Create a backup to make a restore point." />}>
              <div class="space-y-2" aria-live="polite"><For each={backupsQuery.data ?? []}>{(backup) => <div class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2"><div><div class="text-xs font-semibold">{backup.createdAt}</div><div class="text-[11px] text-[var(--text-3)]">{formatBytes(backup.sizeBytes)}{backup.includesDatabase ? " · includes database" : ""}</div></div><div class="flex flex-wrap gap-1.5"><Button type="button" size="sm" variant="ghost" onClick={() => void download(backup)} disabled={disabledByScope(canBackups()) || backupPending()}><Download size={13} aria-hidden="true" />{downloadingId() === backup.id ? "Downloading…" : "Download"}</Button><Button type="button" size="sm" variant="secondary" onClick={() => restore(backup, true)} disabled={disabledByScope(canBackups()) || backupPending()}>Dry run</Button><Button type="button" size="sm" variant="outline" onClick={() => restore(backup, false)} disabled={disabledByScope(canBackups()) || backupPending()}>{restoreMutation.isPending ? "Restoring…" : "Restore"}</Button><Button type="button" size="sm" variant="danger" onClick={() => remove(backup)} disabled={disabledByScope(canBackups()) || backupPending()}><Trash2 size={13} aria-hidden="true" />Delete</Button></div></div>}</For></div>
            </Show>
          </Show>
          <Show when={restoreFailure()}><p role="alert" class="mt-3 text-xs text-[var(--red)]">Restore failed: {restoreFailure()}</p></Show>
        </Card>

        <Card>
          <CardHeader title="Operational tools" icon={Wrench} sub="Dangerous actions are scoped, confirmed, and serialized." />
          <div class="grid gap-4 lg:grid-cols-2">
            <div class="space-y-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] p-3"><div class="text-xs font-semibold">Cache and reindex</div><div class="flex flex-wrap gap-2"><select aria-label="Cache name" class="h-9 rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-2 text-xs" value={cacheName()} onChange={(event) => setCacheName(event.currentTarget.value)} disabled={toolsPending() || disabledByScope(canCache())}><option value="catalog">Catalog</option><option value="accounts">Accounts</option><option value="proxies">Proxies</option><option value="telemetry">Telemetry</option></select><Button type="button" size="sm" onClick={() => toolMutation.mutate({ route: `/tools/cache/${cacheName()}` })} disabled={toolsPending() || disabledByScope(canCache())}><RefreshCw size={13} aria-hidden="true" />Flush cache</Button></div><div class="flex flex-wrap gap-2"><select aria-label="Reindex target" class="h-9 rounded-lg border border-[var(--inner-border)] bg-[var(--surface-muted)] px-2 text-xs" value={reindexTarget()} onChange={(event) => setReindexTarget(event.currentTarget.value)} disabled={toolsPending() || disabledByScope(canHealth())}><option value="catalog">Catalog</option><option value="accounts">Accounts</option></select><Button type="button" size="sm" variant="secondary" onClick={() => toolMutation.mutate({ route: "/tools/reindex", body: { target: reindexTarget() } })} disabled={toolsPending() || disabledByScope(canHealth())}>Reindex</Button></div></div>
            <div class="space-y-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] p-3"><div class="text-xs font-semibold">Connectivity probe</div><Label>HTTP URL<Input ref={setProbeInput} disabled={toolsPending() || disabledByScope(canHealth())} placeholder="https://service.example/health" /></Label><Button type="button" size="sm" variant="secondary" disabled={toolsPending() || disabledByScope(canHealth())} onClick={probe}><RefreshCw size={13} aria-hidden="true" />{toolsPending() ? "Probing…" : "Probe"}</Button></div>
            <div class="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] p-3 lg:col-span-2"><div><div class="text-xs font-semibold">Restart daemon</div><p class="text-[11px] text-[var(--text-3)]">Active requests may be interrupted.</p></div><Button type="button" variant="danger" onClick={() => requestConfirmation(DESTRUCTIVE_CONFIRMATION, () => toolMutation.mutate({ route: "/tools/restart" }))} disabled={toolsPending() || disabledByScope(canLifecycle())}><RotateCcw size={13} aria-hidden="true" />{toolsPending() ? "Restarting…" : "Restart"}</Button></div>
          </div>
          <Show when={!scopeKnown()}><p class="mt-3 text-xs text-[var(--text-3)]">Operational controls are unavailable until the daemon session scope is known.</p></Show>
        </Card>

        <Card className="flex items-start gap-2"><AlertTriangle size={15} class="mt-0.5 text-[var(--orange)]" aria-hidden="true" /><p class="text-xs text-[var(--text-2)]">Credentials, cookies, prompts, provider responses, and raw backup contents are never submitted to or retained by these controls.</p><Settings2 size={15} class="ml-auto text-[var(--text-3)]" aria-hidden="true" /></Card>
      </div>
      <Dialog open={confirmation() !== null} onClose={() => setConfirmation(null)} title="Confirm operation" footer={<><Button type="button" variant="ghost" onClick={() => setConfirmation(null)}>Cancel</Button><Button type="button" variant="danger" onClick={acceptConfirmation}>Continue</Button></>}>
        <p class="text-sm text-[var(--text-2)]">{confirmation()?.message}</p>
      </Dialog>
    </>
  );
}
