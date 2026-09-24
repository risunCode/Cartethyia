import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export interface BackLinkProps {
  readonly to: string;
  readonly label: string;
}

/** Consistent detail-page back link. */
export function BackLink({ to, label }: BackLinkProps): ReactNode {
  return (
    <Link
      to={to}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        color: "var(--accent)",
        fontSize: "12px",
        textDecoration: "none",
      }}
    >
      <ArrowLeft size={14} aria-hidden="true" />
      {label}
    </Link>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly badges?: ReactNode;
  readonly actions?: ReactNode;
  readonly back?: BackLinkProps;
}

/** Detail-page identity header with optional navigation and actions. */
export function PageHeader({
  title,
  description,
  icon,
  badges,
  actions,
  back,
}: PageHeaderProps): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {back ? <BackLink {...back} /> : null}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          {icon ? <div className="card-header-icon">{icon}</div> : null}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <h1 style={{ fontSize: "16px", fontWeight: 700 }}>{title}</h1>
              {badges}
            </div>
            {description ? <p style={{ marginTop: "2px", fontSize: "11.5px", color: "var(--text-tertiary)" }}>{description}</p> : null}
          </div>
        </div>
        {actions ? <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>{actions}</div> : null}
      </div>
    </div>
  );
}
