/**
 * Clipboard writes, owned by the pattern that reports them.
 *
 * The only caller is `useClipboard`, which every copy affordance in the
 * dashboard goes through — so the origin/permission failure is answered once,
 * by {@link ClipboardButton}, as "Clipboard unavailable on this origin". A raw
 * `navigator.clipboard.writeText` at a call site produces an unhandled
 * rejection on an insecure origin and a button that silently does nothing.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
