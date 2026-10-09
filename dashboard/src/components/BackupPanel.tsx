import { DatabaseBackup, Download, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Input } from "./ui/input";
import { Stack } from "./ui/stack";
import { Switch } from "./ui/switch";
import { toast } from "../lib/toast";
import { downloadBytes, downloadTextFile } from "../lib/download";
import { getErrorMessage } from "../lib/helpers";
import { useDeleteAllBackup, useExportBackup, useRestoreBackup } from "../hooks/backup";
import { Dialog } from "./ui/dialog";
import type { BackupImportReport } from "../data/contracts";
import type { DeleteAllScope } from "../../../src/console/backup/store";

/**
 * Backup and restore, as a Settings panel.
 *
 * Both actions re-authenticate with the console password, so the form is the
 * same shape for each: type the password, then export or import. The password
 * is never stored — it goes with the one request and is cleared on success.
 *
 * The copy carries the two facts an operator needs before they click, because
 * both behave in ways that are surprising otherwise: the export is plain JSON
 * containing every provider credential, and history restored from older than
 * the retention window is pruned again on the next sweep.
 */

/** Renders a router-import report: what landed, what did not, and why. */
function ImportReportPanel({ report }: { readonly report: BackupImportReport }): ReactNode {
  const imported = Object.entries(report.imported).filter(([, count]) => count > 0);
  return (
    <Stack gap="8px">
      {imported.length > 0 ? (
        <p style={{ fontSize: "12px" }}>
          Imported: {imported.map(([name, count]) => `${count} ${name}`).join(", ")}
        </p>
      ) : null}
      {report.remapped.length > 0 ? (
        <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
          Remapped provider ids: {report.remapped.join(", ")}
        </p>
      ) : null}
      {report.skipped.length > 0 ? (
        <div>
          <p style={{ fontSize: "12px", color: "var(--yellow)" }}>
            Skipped ({report.skipped.length}) — nothing was guessed:
          </p>
          <ul style={{ fontSize: "11px", color: "var(--text-tertiary)", margin: "4px 0 0 16px" }}>
            {report.skipped.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.warnings.length > 0 ? (
        <div>
          <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Warnings:</p>
          <ul style={{ fontSize: "11px", color: "var(--text-tertiary)", margin: "4px 0 0 16px" }}>
            {report.warnings.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Stack>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function transferLabel(transfer: { loaded: number; total: number | null; startedAt: number } | null, fallback: string): string {
  if (transfer === null) return fallback;
  const seconds = Math.max((Date.now() - transfer.startedAt) / 1000, 0.1);
  const speed = formatBytes(transfer.loaded / seconds);
  const size = transfer.total === null ? formatBytes(transfer.loaded) : `${formatBytes(transfer.loaded)} / ${formatBytes(transfer.total)}`;
  return `${size} · ${speed}/s`;
}
export function BackupPanel(): ReactNode {
  const [password, setPassword] = useState("");
  const [passwordFor, setPasswordFor] = useState<"download" | "restore" | "delete" | null>(null);
  const [includeConfig, setIncludeConfig] = useState(true);
  const [includeTelemetry, setIncludeTelemetry] = useState(false);
  const [highlyCompress, setHighlyCompress] = useState(true);
  const [transfer, setTransfer] = useState<{ loaded: number; total: number | null; startedAt: number } | null>(null);
  const [restored, setRestored] = useState<Record<string, number> | null>(null);
  const [report, setReport] = useState<BackupImportReport | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const [deleteScopes, setDeleteScopes] = useState<ReadonlySet<DeleteAllScope>>(new Set());
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportBackup = useExportBackup();
  const restoreBackup = useRestoreBackup();
  const deleteAllBackup = useDeleteAllBackup();
  const toggleDeleteScope = (scope: DeleteAllScope) => {
    setDeleteScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };
  const closePassword = () => {
    setPasswordFor(null);
    setPassword("");
  };
  const askDelete = () => {
    if (deleteScopes.size === 0) return;
    setPassword("");
    setPasswordFor("delete");
  };
  const performDelete = async () => {
    if (password.length === 0) return;
    const result = await deleteAllBackup.mutateAsync({ password, scopes: [...deleteScopes] });
    setDeleteScopes(new Set());
    closePassword();
    toast.success("Selected configuration deleted.", Object.entries(result.deleted).map(([table, count]) => `${table}: ${count}`).join(" · "));
  };
  const download = () => {
    const sections = [
      ...(includeConfig ? ["config"] : []),
      ...(includeTelemetry ? ["telemetry"] : []),
    ].join(",");
    if (sections.length === 0) {
      toast.error("Select at least one backup section.");
      return;
    }
    exportBackup.mutate(
      { password, sections, compressed: highlyCompress, onProgress: (progress) => setTransfer((current) => ({ ...progress, startedAt: current?.startedAt ?? Date.now() })) },
      {
        onSuccess: (payload) => {
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          if (payload instanceof Uint8Array) {
            downloadBytes(`cartethyia_backup_${stamp}.json.gz`, payload, "application/gzip");
          } else {
            downloadTextFile(
              `cartethyia_backup_${stamp}.json`,
              JSON.stringify(payload, null, 2),
              "application/json",
            );
          }
          closePassword();
          toast.success("Backup downloaded.");
        },
        onError: (error) => toast.error(getErrorMessage(error, "Backup export failed.")),
      },
    );
  };

  const upload = (file: File) => {
    setPendingRestoreFile(file);
    setPassword("");
    setPasswordFor("restore");
  };
  const performRestore = async () => {
    const file = pendingRestoreFile;
    if (file === null) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      throw new Error("Could not read that file.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("That file is not valid JSON.");
    }
    const result = await restoreBackup.mutateAsync({ password, backup: parsed, onProgress: (progress) => setTransfer((current) => ({ ...progress, startedAt: current?.startedAt ?? Date.now() })) });
    setRestored(result.restored);
    setReport(result.report ?? null);
    setFormat(result.format);
    closePassword();
    setPendingRestoreFile(null);
    toast.success("Restore complete.");
  };

  const restoreRows = restored === null ? [] : Object.entries(restored);

  return (
    <>
    <div className="two-column-grid">
      <Card className="h-full">
        <CardHeader
          title="Backup"
          subtitle="Download a JSON snapshot, or restore one you already trust"
          icon={<DatabaseBackup size={16} />}
        />
        <CardBody className="flex flex-1 flex-col">
          <Stack gap="14px" className="flex-1">
            <fieldset className="backup-section-options">
              <legend>Include in the download</legend>
              <label className="backup-section-option">
                <input type="checkbox" checked={includeConfig} onChange={(event) => setIncludeConfig(event.target.checked)} />
                <span>
                  <strong>Account, proxy &amp; settings</strong>
                  <small>Credentials, API-key hashes, routing, and settings</small>
                </span>
              </label>
              <label className="backup-section-option">
                <input type="checkbox" checked={includeTelemetry} onChange={(event) => setIncludeTelemetry(event.target.checked)} />
                <span>
                  <strong>Telemetry history</strong>
                  <small>Status, tokens, cost, latency — never prompt bodies</small>
                </span>
              </label>
            </fieldset>
            <div className="flex items-center justify-between gap-[12px] rounded-[10px] border border-inner-border px-[12px] py-[10px]">
              <span>
                <strong className="block text-[13px]">Highly Compress Backup</strong>
                <small className="text-[11px] text-text-tertiary">Makes the download smaller.</small>
              </span>
              <Switch checked={highlyCompress} onChange={setHighlyCompress} aria-label="Highly Compress Backup" />
            </div>
            <p className="form-section-caption">
              The file contains provider credentials. Treat it like the database. Prompt and response bodies, health-event history, and console sessions are left out.
            </p>
            <div className="mt-auto flex justify-end gap-[8px]">
              <Button variant="primary" size="sm" onClick={() => { setPassword(""); setPasswordFor("download"); }} disabled={!includeConfig && !includeTelemetry} icon={<Download size={13} />}>
                Download backup
              </Button>
              <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()} icon={<Upload size={13} />}>
                Restore from file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                  event.target.value = "";
                }}
              />
            </div>
            {format !== null ? (
              <p className="form-section-caption">Detected format: {format === "nine_router" ? "router export" : "Cartethyia backup"}</p>
            ) : null}
            {restoreRows.length > 0 ? (
              <div className="status-callout" data-tone="ok">
                <strong>Restored rows</strong>
                <ul>{restoreRows.map(([table, count]) => <li key={table}>{table}: {count}</li>)}</ul>
              </div>
            ) : null}
            {report !== null ? <ImportReportPanel report={report} /> : null}
          </Stack>
        </CardBody>
      </Card>

      <Card className="settings-danger h-full">
        <CardHeader
          title="Delete data"
          subtitle="Removes the scopes you check. Console users, sessions, and audit history stay."
          icon={<Trash2 size={16} />}
        />
        <CardBody className="flex flex-1 flex-col">
          <Stack gap="12px" className="flex-1">
            <fieldset className="backup-section-options">
              <legend>Delete</legend>
              {([
                ["providers", "Providers", "Accounts, credentials, tenant models, routing, and account health"],
                ["proxies", "Proxies", "Network pools, pool settings, and pool health"],
                ["configuration", "All configuration", "Providers, proxies, aliases, combos, API keys, CLI tools, settings, and Studio"],
              ] as const).map(([scope, label, description]) => (
                <label key={scope} className="backup-section-option">
                  <input type="checkbox" checked={deleteScopes.has(scope)} onChange={() => toggleDeleteScope(scope)} />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="mt-auto flex justify-end">
              <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={deleteScopes.size === 0} onClick={askDelete}>
                Delete selected
              </Button>
            </div>
          </Stack>
        </CardBody>
      </Card>
    </div>
    <Dialog
      open={passwordFor !== null}
      onClose={closePassword}
      title={passwordFor === "delete" ? "Confirm deletion" : passwordFor === "restore" ? "Restore backup" : "Download backup"}
      description="The console password is checked again before this runs."
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={closePassword}>Cancel</Button>
          <Button
            variant={passwordFor === "delete" ? "danger" : "primary"}
            size="sm"
            loading={exportBackup.isPending || restoreBackup.isPending || deleteAllBackup.isPending}
            disabled={password.length === 0 || exportBackup.isPending || restoreBackup.isPending || deleteAllBackup.isPending}
            onClick={() => {
              setTransfer(null);
              if (passwordFor === "download") download();
              else if (passwordFor === "restore") void performRestore();
              else void performDelete();
            }}
          >
            {exportBackup.isPending
              ? transferLabel(transfer, "Downloading…")
              : restoreBackup.isPending
                ? transferLabel(transfer, "Uploading…")
                : deleteAllBackup.isPending
                  ? "Working…"
                  : passwordFor === "delete"
                    ? "Delete permanently"
                    : passwordFor === "restore"
                      ? "Restore"
                      : "Download"}
          </Button>
        </>
      }
    >
      <Stack gap="10px">
        <p className="form-section-caption">
          {passwordFor === "delete"
            ? "This cannot be undone. The password is verified again before anything is removed."
            : passwordFor === "restore"
              ? "Restore replaces the tenant configuration in this file. Continue only if the file is trusted."
              : "The export is plain JSON and contains provider credentials."}
        </p>
        <Input
          label="Console password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          autoFocus
        />
      </Stack>
    </Dialog>
    </>
  );
}
