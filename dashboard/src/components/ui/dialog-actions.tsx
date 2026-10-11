import type { ReactNode } from "react";

/**
 * Right-aligned action row for forms inside dialogs and panels.
 *
 * The Dialog primitive has its own `footer` prop (`.modal-footer`); this
 * component covers the other case — an inline `<form>` that ends in Cancel /
 * Submit and had been re-declaring the same flex-end row inline on every page.
 *
 * `.dialog-actions` is a marker only — it carries no declarations — so the row is
 * expressed as utilities (`gap-4`/`mt-4` are 8px on the `--spacing: 2px` scale).
 */
export function DialogActions({ children }: { children: ReactNode }): ReactNode {
  return <div className="dialog-actions mt-4 flex justify-end gap-4">{children}</div>;
}
