import { sanitizeMessage } from "../../application/contracts";
import { validateRestorePayload } from "../../storage";
import { verifyConsolePassword } from "../session";
import type { BackupActionResult, BackupRepository, SettingsRepository } from "../views";
import type { BackupPayload } from "../../storage";

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

export class BackupService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly backups: BackupRepository,
  ) {}

  async verifyPassword(password: unknown): Promise<BackupActionResult> {
    const snapshot = await this.settings.get();
    const verified =
      snapshot.passwordHash !== null &&
      typeof password === "string" &&
      (await verifyConsolePassword(password, snapshot.passwordHash));
    return verified
      ? { ok: true, status: 200, code: null, message: "" }
      : { ok: false, status: 401, code: "unauthorized", message: "password is wrong" };
  }

  exportBackup(): BackupPayload {
    return this.backups.exportBackup();
  }

  async resetAll(password: unknown, confirmation: unknown, resetConfig: () => void, resetRuntime: () => void): Promise<BackupActionResult> {
    const verified = await this.verifyPassword(password);
    if (!verified.ok) return verified;
    if (confirmation !== "RESET ALL DATABASE AND RUNTIME") return { ok: false, status: 400, code: "invalid_request", message: "confirmation text is incorrect" };
    try {
      resetConfig();
      resetRuntime();
      return { ok: true, status: 200, code: null, message: "all configuration and runtime data reset" };
    } catch (error) {
      return { ok: false, status: 500, code: "internal_error", message: `Database reset failed: ${error instanceof Error ? sanitizeMessage(error) : "unknown error"}` };
    }
  }

  async restore(password: unknown, payload: unknown): Promise<BackupActionResult> {
    const verified = await this.verifyPassword(password);
    if (!verified.ok) return verified;
    const validation = validateRestorePayload(payload);
    if (!validation.ok) {
      return { ok: false, status: 400, code: "invalid_request", message: validation.error };
    }
    try {
      this.backups.restore(validation);
      return { ok: true, status: 200, code: null, message: "backup restored" };
    } catch (error) {
      return { ok: false, status: 500, code: "internal_error", message: `Backup restore failed: ${error instanceof Error ? sanitizeMessage(error) : "unknown error"}; configuration was left unchanged` };
    }
  }
}
