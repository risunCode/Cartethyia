import { DatabaseBackup, Download, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Input } from "./ui/input";
import { Inline } from "./ui/inline";
import { Stack } from "./ui/stack";
import { toast } from "../lib/toast";
import { downloadTextFile } from "../lib/download";
import { getErrorMessage } from "../lib/helpers";
import { useExportBackup, useRestoreBackup } from "../lib/hooks/backup";
import type { BackupImportReport } from "../lib/contracts";

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

export function BackupPanel(): ReactNode {
  const [password, setPassword] = useState("");
  const [includeConfig, setIncludeConfig] = useState(true);
  const [includeTelemetry, setIncludeTelemetry] = useState(false);
  const [restored, setRestored] = useState<Record<string, number> | null>(null);
  const [report, setReport] = useState<BackupImportReport | null>(null);
  const [format, setFormat] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const exportBackup = useExportBackup();
  const restoreBackup = useRestoreBackup();
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
      { password, sections },
      {
        onSuccess: (payload) => {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          downloadTextFile(
            `cartethyia-backup-${stamp}.json`,
            JSON.stringify(payload, null, 2),
            "application/json",
          );
          setPassword("");
          toast.success("Backup downloaded.");
        },
        onError: (error) => toast.error(getErrorMessage(error, "Backup export failed.")),
      },
    );
  };

  const upload = (file: File) => {
    void file
      .text()
      .then((text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          toast.error("That file is not valid JSON.");
          return;
        }
        restoreBackup.mutate(
          { password, backup: parsed },
          {
            onSuccess: (result) => {
              setRestored(result.restored);
              setReport(result.report ?? null);
              setFormat(result.format);
              setPassword("");
              toast.success("Restore complete.");
            },
            onError: (error) => toast.error(getErrorMessage(error, "Restore failed.")),
          },
        );
      })
      .catch(() => toast.error("Could not read that file."));
  };

  const restoreRows = restored === null ? [] : Object.entries(restored);

  return (
    <Card>
      <CardHeader
        title="Backup & Restore"
        subtitle="Export your configuration and history, or restore them from a file"
        icon={<DatabaseBackup size={16} />}
      />
      <CardBody>
        <Stack gap="14px">
          <Input
            id="backup-password"
            label="Console password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          <fieldset className="backup-section-options">
            <legend>Backup sections</legend>
            <label className="backup-section-option">
              <input
                type="checkbox"
                checked={includeConfig}
                onChange={(event) => setIncludeConfig(event.target.checked)}
              />
              <span>Account, proxy &amp; settings</span>
            </label>
            <label className="backup-section-option">
              <input
                type="checkbox"
                checked={includeTelemetry}
                onChange={(event) => setIncludeTelemetry(event.target.checked)}
              />
              <span>Telemetry history</span>
            </label>
          </fieldset>
          <p style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            Both actions re-authenticate with your console password. The export is plain JSON
            containing every provider credential and API-key hash — treat the file exactly as you
            would the database.
          </p>

          <Inline justify="flex-start">
            <Button
              variant="primary"
              size="sm"
              onClick={download}
              disabled={exportBackup.isPending || password.length === 0}
            >
              <Download size={14} /> {exportBackup.isPending ? "Exporting…" : "Download backup"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInput.current?.click()}
              disabled={restoreBackup.isPending || password.length === 0}
            >
              <Upload size={14} /> {restoreBackup.isPending ? "Restoring…" : "Restore from file"}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) upload(file);
                event.target.value = "";
              }}
            />
          </Inline>

          <p style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            A backup carries request metadata only — status, tokens, cost, latency — never prompt or
            response bodies, so it is not a substitute for a database dump. Restored history older
            than the retention window is pruned again on the next sweep; raise
            <code> CARTETHYIA_TELEMETRY_RETENTION_DAYS </code> if you need it to persist. A restore
            only ever touches your own tenant&apos;s rows.
          </p>

          {format !== null ? (
            <p style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              Detected format: {format === "nine_router" ? "router export" : "Cartethyia backup"}
            </p>
          ) : null}

          {restoreRows.length > 0 ? (
            <div>
              <p style={{ fontSize: "12px" }}>Restored rows:</p>
              <ul style={{ fontSize: "11px", color: "var(--text-tertiary)", margin: "4px 0 0 16px" }}>
                {restoreRows.map(([table, count]) => (
                  <li key={table}>
                    {table}: {count}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {report !== null ? <ImportReportPanel report={report} /> : null}
        </Stack>
      </CardBody>
    </Card>
  );
}
