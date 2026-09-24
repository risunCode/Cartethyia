/**
 * Backup and restore operations, plus the import path for a router export.
 *
 * Two things every entry point here has in common:
 *
 * 1. **Nothing is written before the whole payload validates.** Validation
 *    resolves every table and column against the live schema, so a stale or
 *    hostile file fails with the offending name and the database is untouched.
 * 2. **Everything happens in one transaction** (see `store.applyRestore`), so a
 *    mid-restore SQL error rolls back rather than leaving half a
 *    configuration — which is the state that makes an operator's day worse than
 *    a plain failure would.
 *
 * Export is plain JSON at the operator's explicit request. That means the file
 * carries provider credentials and API-key hashes, so it is as sensitive as the
 * database: the layer doc and the dashboard copy say so, and export requires
 * password re-authentication.
 */
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { ConsoleDomainError } from "../shared/errors";
import { CONFIG_TABLES, TELEMETRY_TABLES, TENANT_TABLE } from "./contracts";
import type { BackupSection } from "./contracts";
import { exportBackup, applyRestore } from "./store";
import { detectFormat, restoreOrder, validateRestorePayload } from "./validate";
import { convert9RouterBackup, type ImportReport } from "./nine-router";

export interface BackupServiceOptions {
  readonly db: CartethyiaDatabase;
  /** Verifies the signed-in operator's console password; supplied by the router. */
  readonly verifyPassword: (password: string) => Promise<boolean>;
}

export interface ExportOptions {
  readonly sections?: readonly BackupSection[];
  readonly password: string;
  /** The tenant whose rows are exported. Never another tenant's. */
  readonly tenantId: string;
}

export interface ImportResult {
  readonly restored: Record<string, number>;
  readonly skipped: Record<string, number>;
  readonly report?: ImportReport;
  readonly format: "native" | "nine_router";
}

function sectionsOrDefault(sections: readonly BackupSection[] | undefined): readonly BackupSection[] {
  if (sections === undefined || sections.length === 0) return ["config", "telemetry"];
  for (const section of sections) {
    if (section !== "config" && section !== "telemetry") {
      throw new ConsoleDomainError("invalid_request", 400, `unknown backup section "${String(section)}"`);
    }
  }
  return sections;
}

export class BackupService {
  constructor(private readonly options: BackupServiceOptions) {}

  /** Tables an export of these sections reads. */
  private tablesFor(sections: readonly BackupSection[]) {
    const tables = [];
    if (sections.includes("config")) tables.push(...CONFIG_TABLES, TENANT_TABLE);
    if (sections.includes("telemetry")) tables.push(...TELEMETRY_TABLES);
    return tables;
  }

  async export(options: ExportOptions): Promise<{ payload: unknown; counts: Record<string, number> }> {
    if (!(await this.options.verifyPassword(options.password))) {
      throw new ConsoleDomainError("unauthorized", 401, "password is incorrect");
    }
    const sections = sectionsOrDefault(options.sections);
    const { payload, counts } = await exportBackup(
      this.options.db,
      this.tablesFor(sections),
      options.tenantId,
    );
    return { payload, counts };
  }

  /**
   * Restores a payload, detecting its format first.
   *
   * A native payload is validated as-is. A router export is converted first —
   * and conversion is itself validation, because it refuses provider ids it
   * cannot map rather than guessing — then the converted payload goes through
   * the identical validation and transaction as a native one. There is one
   * write path, not two.
   *
   * `tenantId` is the restoring tenant, and it is the *only* tenant any write
   * can reach: the payload cannot name a different one, because every table is
   * filtered by ownership and the tenant row is forced to this id.
   */
  async restore(
    password: unknown,
    payload: unknown,
    tenantId: string,
  ): Promise<ImportResult> {
    if (typeof password !== "string" || !(await this.options.verifyPassword(password))) {
      throw new ConsoleDomainError("unauthorized", 401, "password is incorrect");
    }

    const detected = detectFormat(payload);
    if (detected.kind === "unknown") {
      throw new ConsoleDomainError("invalid_request", 400, detected.reason);
    }

    if (detected.kind === "nine_router") {
      const { payload: converted, report } = convert9RouterBackup(detected.payload, tenantId);
      const result = await this.apply(converted, tenantId);
      return { ...result, report, format: "nine_router" };
    }

    const result = await this.apply(detected.payload, tenantId);
    return { ...result, format: "native" };
  }

  /** Validates and applies a native payload. Shared by both formats. */
  private async apply(
    payload: unknown,
    tenantId: string,
  ): Promise<{ restored: Record<string, number>; skipped: Record<string, number> }> {
    const validation = validateRestorePayload(payload, tenantId);
    if (!validation.ok) {
      throw new ConsoleDomainError("invalid_request", 400, validation.error);
    }
    try {
      return await applyRestore(this.options.db, validation.value, restoreOrder(), tenantId);
    } catch (error) {
      // The message carries table and column names only — the store never
      // interpolates a cell value — so a failed restore cannot leak credentials
      // into a log or an HTTP response.
      throw new ConsoleDomainError(
        "restore_failed",
        500,
        `restore failed and was rolled back: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /** Counts a section would export, without building the payload. */
  async preview(
    sections: readonly BackupSection[] | undefined,
    tenantId: string,
  ): Promise<Record<string, number>> {
    const { counts } = await exportBackup(
      this.options.db,
      this.tablesFor(sectionsOrDefault(sections)),
      tenantId,
    );
    return counts;
  }
}
