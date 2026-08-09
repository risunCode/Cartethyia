/** Writes text to the browser clipboard and reports origin or permission failures. */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
