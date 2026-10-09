import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

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
    <div className={cn("section-header", hasText ? undefined : "justify-end")}>
      {hasText ? (
        <div className="section-header-text">
          {eyebrow ? (
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary mb-[2px]">
              {eyebrow}
            </p>
          ) : null}
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
  size = "default",
}: {
  label: string;
  value: string;
  detail: ReactNode;
  icon?: ReactNode;
  tone?: "teal" | "purple" | "green" | "orange" | "red" | "accent";
  status?: string;
  valueColor?: string;
  action?: ReactNode;
  size?: "default" | "roomy";
}) {
  const toneColorMap: Record<string, string> = {
    teal: "text-teal",
    purple: "text-accent",
    green: "text-green",
    orange: "text-orange",
    red: "text-red",
    accent: "text-accent",
  };

  const effectiveTone =
    tone ||
    (status === "cooldown" ? "orange" : status === "disabled" ? "red" : "accent");
  const toneColor = toneColorMap[effectiveTone] ?? "text-accent";
  return (
    <div className={cn("stat-card min-w-0 border border-inner-border rounded-card bg-surface-2", size === "roomy" ? "p-[18px]" : "p-[12px]")}>
      <div
        className={cn(
          "flex items-center justify-between gap-[8px] font-bold uppercase tracking-[0.08em]",
          size === "roomy" ? "text-[12px]" : "text-[10px]",
          toneColor,
        )}
      >
        <span className="inline-flex items-center gap-[8px] min-w-0">
          {icon}
          <span>{label}</span>
        </span>
        {action ? <span className="shrink-0">{action}</span> : null}
      </div>
      <p
        className={cn("font-mono tabular-nums font-bold leading-[1.15] mb-0", size === "roomy" ? "text-[28px] mt-[8px]" : "text-[20px] mt-[2px]")}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </p>
      <span className={cn("stat-card-detail text-text-secondary", size === "roomy" ? "mt-[4px] block text-[13px]" : "text-[11px]")}>{detail}</span>
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
  dense = false,
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
  /** Tighter cell padding for dense forms (the setup credential table). */
  dense?: boolean;
}) {
  return (
    <div
      className={cn("data-table-container", scrollRegion && "scroll-region")}
      style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
      onScroll={onScroll}
    >
      <table className={cn("data-table", dense && "data-table-dense")}>
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
                      className="inline-flex items-center gap-[4px] cursor-pointer"
                    >
                      <span>{label}</span>
                      <span aria-hidden="true" className={cn("text-[9px]", active ? "opacity-100" : "opacity-[0.35]")}>
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
