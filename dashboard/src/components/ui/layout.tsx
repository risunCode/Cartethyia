import type { ReactNode } from "react";

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
  icon,
  level = 2,
}: {
  eyebrow?: string;
  title?: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  level?: 1 | 2 | 3;
}) {
  const hasText = Boolean(eyebrow || title || description);
  const Title = level === 1 ? "h1" : level === 3 ? "h3" : "h2";
  return (
    <div className="section-header" style={hasText ? undefined : { justifyContent: "flex-end" }}>
      {hasText ? (
        <div className="section-header-text">
          {eyebrow ? <p style={{ fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-tertiary)", marginBottom: "2px" }}>{eyebrow}</p> : null}
          {title ? <Title>{title}</Title> : null}
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}
      {icon ? <div className="card-header-icon">{icon}</div> : null}
      {action ? <div className="section-header-action">{action}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  detail,
  icon,
  tone,
  status,
  valueColor,
  action,
}: {
  label: string;
  value: string;
  detail: ReactNode;
  icon?: ReactNode;
  tone?: "teal" | "purple" | "green" | "orange" | "red" | "accent";
  status?: string;
  valueColor?: string;
  action?: ReactNode;
}) {
  const toneColorMap: Record<string, string> = {
    teal: "var(--teal)",
    purple: "var(--purple)",
    green: "var(--green)",
    orange: "var(--orange)",
    red: "var(--red)",
    accent: "var(--accent)",
  };

  const effectiveTone =
    tone ||
    (status === "cooldown" ? "orange" : status === "disabled" ? "red" : "accent");
  const toneColor = toneColorMap[effectiveTone] || "var(--accent)";
  return (
    <div className="stat-card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "6px",
          fontSize: "10px",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: toneColor,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
          {icon}
          <span>{label}</span>
        </span>
        {action ? <span style={{ flexShrink: 0 }}>{action}</span> : null}
      </div>
      <p
        className="mono-text" style={{ fontSize: "20px",
          fontWeight: 700,
          color: valueColor || "var(--text-primary)",
          lineHeight: 1.2,
          margin: "2px 0 0 0" }}
      >
        {value}
      </p>
      <span className="stat-card-detail" style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
        {detail}
      </span>
    </div>
  );
}

export interface DataTableColumn {
  readonly key: string;
  readonly label: string;
  readonly sortable?: boolean;
}

export function DataTable({
  headers,
  children,
  maxHeight,
  onScroll,
  sortKey,
  sortDirection,
  onSort,
  scrollRegion = false,
}: {
  headers: readonly (string | DataTableColumn)[];
  children: ReactNode;
  maxHeight?: number;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  sortKey?: string;
  sortDirection?: "asc" | "desc";
  onSort?: (key: string) => void;
  /** Style the scroll box like the sidebar rail (thin overlay scrollbar). */
  scrollRegion?: boolean;
}) {
  return (
    <div
      className={`data-table-container${scrollRegion ? " scroll-region" : ""}`}
      style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
      onScroll={onScroll}
    >
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((header) => {
              const key = typeof header === "string" ? header : header.key;
              const label = typeof header === "string" ? header : header.label;
              const sortable = typeof header !== "string" && header.sortable === true && onSort !== undefined;
              const active = sortKey === key;
              return (
                <th scope="col" key={key} aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}>
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(key)}
                      title={`Sort by ${label}`}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        font: "inherit",
                        color: "inherit",
                        textTransform: "inherit",
                        letterSpacing: "inherit",
                      }}
                    >
                      <span>{label}</span>
                      <span aria-hidden="true" style={{ fontSize: "9px", opacity: active ? 1 : 0.35 }}>
                        {active ? (sortDirection === "asc" ? "▲" : "▼") : "△"}
                      </span>
                    </button>
                  ) : (
                    label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
