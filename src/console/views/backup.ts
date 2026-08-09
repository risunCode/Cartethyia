import type { BackupPayload, RestoreResult, RestoreValidation } from "../../storage";
import type { ConsoleErrorCode } from "./errors";

// Backup / restore
// ---------------------------------------------------------------------------

export interface BackupRepository {
  exportBackup(): BackupPayload;
  restore(validation: Extract<RestoreValidation, { ok: true }>): RestoreResult;
}

export interface BackupActionResult {
  readonly ok: boolean;
  readonly status: number;
  readonly code: ConsoleErrorCode | null;
  readonly message: string;
}

