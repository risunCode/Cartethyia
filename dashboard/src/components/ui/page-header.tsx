import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";

export interface BackLinkProps {
  readonly to: string;
  readonly label: string;
}

/** Consistent detail-page back link. */
export function BackLink({ to, label }: BackLinkProps): ReactNode {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-[6px] text-accent text-[12px] no-underline"
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
    <div className="flex flex-col gap-[10px]">
      {back ? <BackLink {...back} /> : null}
      <div className="flex items-center justify-between gap-[12px] flex-wrap">
        <div className="flex items-center gap-[10px] min-w-0">
          {icon ? <div className="card-header-icon">{icon}</div> : null}
          <div className="min-w-0">
            <div className="flex items-center gap-[8px] flex-wrap">
              <h1 className="text-[16px] font-bold">{title}</h1>
              {badges}
            </div>
            {description ? (
              <p className="mt-[2px] text-[11.5px] text-text-tertiary">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className={cn("flex items-center gap-[8px] flex-wrap min-w-0 max-w-full")}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
