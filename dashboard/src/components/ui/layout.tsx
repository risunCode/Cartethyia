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
            <p className="text-badge font-bold uppercase tracking-label text-text-tertiary mb-1">
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
    <div className={cn("stat-card min-w-0 border border-inner-border rounded-card bg-surface-2", size === "roomy" ? "p-9" : "p-6")}>
      <div
        className={cn(
          "flex items-center justify-between gap-4 font-bold uppercase tracking-label",
          size === "roomy" ? "text-caption" : "text-micro",
          toneColor,
        )}
      >
        <span className="inline-flex items-center gap-4 min-w-0">
          {icon}
          <span>{label}</span>
        </span>
        {action ? <span className="shrink-0">{action}</span> : null}
      </div>
      <p
        className={cn("font-mono tabular-nums font-bold leading-[1.15] mb-0", size === "roomy" ? "text-hero mt-4" : "text-display mt-1")}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </p>
      <span className={cn("stat-card-detail text-text-secondary", size === "roomy" ? "mt-2 block text-body" : "text-badge")}>{detail}</span>
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
      <table className={cn("data-table text-caption", dense && "text-badge [&_th]:px-4 [&_th]:py-2.5 [&_td]:px-4 [&_td]:py-2.5 [&_th]:text-text-secondary [&_th]:font-semibold [&_th]:normal-case [&_th]:tracking-normal [&_td]:tabular-nums")}>
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
                      className="inline-flex items-center gap-2 cursor-pointer"
                    >
                      <span>{label}</span>
                      <span aria-hidden="true" className={cn("text-micro", active ? "opacity-100" : "opacity-[0.35]")}>
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
