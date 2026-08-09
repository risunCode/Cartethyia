export function formatDbCell(value: unknown, maxLength = 80): string {
  if (value === null) return "∅";
  if (value === undefined) return "";
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) return `<${value.byteLength}B>`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
