import type { ReactNode } from "react";

/**
 * Right-aligned action row for forms inside dialogs and panels.
 *
 * The Dialog primitive has its own `footer` prop (`.modal-footer`); this
 * component covers the other case — an inline `<form>` that ends in Cancel /
 * Submit and had been re-declaring the same flex-end row inline on every page.
 */
export function DialogActions({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="dialog-actions" style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
      {children}
    </div>
  );
}
