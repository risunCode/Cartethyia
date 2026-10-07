import type { ReactNode } from "react";

export interface ToolbarProps {
  readonly children: ReactNode;
  readonly meta?: ReactNode;
  readonly className?: string;
}

/** Responsive filter/action strip shared by data-heavy dashboard pages. */
export function Toolbar({ children, meta, className = "" }: ToolbarProps): ReactNode {
  return (
    <div
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", minWidth: 0 }}>{children}</div>
      {meta ? <div style={{ marginLeft: "auto", color: "var(--text-tertiary)", fontSize: "11px" }}>{meta}</div> : null}
    </div>
  );
}
