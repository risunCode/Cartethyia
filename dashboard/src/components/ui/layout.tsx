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
    (status === "degraded" || status === "cooldown"
      ? "orange"
      : status === "disabled"
        ? "red"
        : "accent");
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
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "20px",
          fontWeight: 700,
          color: valueColor || "var(--text-primary)",
          lineHeight: 1.2,
          margin: "2px 0 0 0",
        }}
      >
        {value}
      </p>
      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{detail}</span>
    </div>
  );
}

export function DataTable({
  headers,
  children,
  maxHeight,
  onScroll,
}: {
  headers: readonly string[];
  children: ReactNode;
  maxHeight?: number;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}) {
  return (
    <div className="data-table-container" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined} onScroll={onScroll}>
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th scope="col" key={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
