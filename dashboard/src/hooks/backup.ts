import { consoleBytes, consoleRequest, consoleUpload } from "../data/api";
import type { TransferProgress } from "../data/api";
import type { ApiErrorShape } from "../data/api";
import type { BackupExportResponse, BackupImportResponse } from "../data/contracts";
import type { DeleteAllScope } from "../../../src/console/backup/store";
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
  return useMutation<BackupExportResponse | Uint8Array, ApiErrorShape, { password: string; sections?: string; compressed?: boolean; onProgress?: (progress: TransferProgress) => void }>({
    mutationFn: async ({ password, sections, compressed, onProgress }) => {
      const query = new URLSearchParams({ password });
      if (sections !== undefined && sections.length > 0) query.set("sections", sections);
      if (compressed === true) query.set("compressed", "1");
      const path = `/backup/export?${query.toString()}`;
      if (compressed !== true) return consoleRequest<BackupExportResponse>(path);
      const envelope = await consoleRequest<{ bytes: string }>(path);
      const binary = atob(envelope.bytes);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
      return bytes;
    },
  });
}

/**
 * Restores a backup file.
 *
 * A successful restore rewrites configuration, so every cached read of it is
 * invalidated rather than left serving the pre-restore state.
 */
export interface DeleteAllResponse {
  readonly deleted: Record<string, number>;
}

export function useDeleteAllBackup() {
  const queryClient = useQueryClient();
  return useMutation<DeleteAllResponse, ApiErrorShape, { password: string; scopes: readonly DeleteAllScope[] }>({
    mutationFn: ({ password, scopes }) =>
      consoleRequest<DeleteAllResponse>("/backup/delete-all", {
        method: "POST",
        body: JSON.stringify({ password, scopes }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}

export function useRestoreBackup() {
  const queryClient = useQueryClient();
  return useMutation<BackupImportResponse, ApiErrorShape, { password: string; backup: unknown; onProgress?: (progress: TransferProgress) => void }>({
    mutationFn: ({ password, backup, onProgress }) =>
      consoleUpload<BackupImportResponse>(
        "/backup/import",
        JSON.stringify({ password, backup }),
        onProgress,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}
