/** Writes text to the browser clipboard and reports origin or permission failures. */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
