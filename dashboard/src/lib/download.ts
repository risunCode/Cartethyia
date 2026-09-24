/**
 * Centralized "download a generated file" helper.
 *
 * Encapsulates the anchor create/click/remove + object-URL lifecycle in one
 * place so callers cannot leak object URLs or revoke them before the browser
 * has started the download. Removal and revocation are deferred to a later
 * task because synchronous revocation aborts the download in some browsers
 * and the click needs the anchor attached to the document in Firefox.
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
