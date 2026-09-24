import { consoleRequest } from "../api";
import type { ApiErrorShape } from "../api";
import type { BackupExportResponse, BackupImportResponse } from "../contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Backup/restore hooks.
 *
 * Both operations re-authenticate the operator's console password on the
 * server, so the password travels with the request rather than being cached
 * anywhere client-side. Export returns the payload as JSON; the page hands it
 * to the download helper, because it is a file the operator keeps rather than a
 * value the app reads back.
 *
 * Restore does not need a hook of its own to decide what the file is: the
 * server detects a native backup from a router export by shape, so the
 * dashboard hands the parsed file over and renders the report it gets back.
 */
export function useExportBackup() {
  return useMutation<BackupExportResponse, ApiErrorShape, { password: string; sections?: string }>({
    mutationFn: ({ password, sections }) => {
      const query = new URLSearchParams({ password });
      if (sections !== undefined && sections.length > 0) query.set("sections", sections);
      return consoleRequest<BackupExportResponse>(`/backup/export?${query.toString()}`);
    },
  });
}

/**
 * Restores a backup file.
 *
 * A successful restore rewrites configuration, so every cached read of it is
 * invalidated rather than left serving the pre-restore state.
 */
export function useRestoreBackup() {
  const queryClient = useQueryClient();
  return useMutation<BackupImportResponse, ApiErrorShape, { password: string; backup: unknown }>({
    mutationFn: ({ password, backup }) =>
      consoleRequest<BackupImportResponse>("/backup/import", {
        method: "POST",
        body: JSON.stringify({ password, backup }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}
