/** Downloads a browser blob without retaining an object URL after the click. */
export function downloadBlob(filename: string, content: BlobPart, type = "application/octet-stream"): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Downloads a JSON value using the dashboard's standard UTF-8 JSON format. */
export function downloadJson(filename: string, value: unknown): void {
  downloadBlob(filename, JSON.stringify(value, null, 2), "application/json");
}

/** Reads and parses a JSON file supplied by a browser file input. */
export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text()) as unknown;
}

/** Formats byte counts for upload and backup affordances. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
