import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "../../lib/classnames";

export interface BackLinkProps {
  /** Used only when this page was opened directly and there is no history entry to return to. */
  readonly to: string;
  readonly label: string;
}

/** Consistent detail-page back link. Goes to the previous page, not a fixed route. */
export function BackLink({ to, label }: BackLinkProps): ReactNode {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        // A direct open (bookmark, pasted URL) has no in-app page to return to.
        // `history.length` counts the current entry, so 1 means this is the first.
        if (window.history.length > 1) navigate(-1);
        else navigate(to);
      }}
      className="inline-flex items-center gap-3 text-accent text-caption bg-transparent border-0 p-0 cursor-pointer"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      {label}
    </button>
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
    <div className="flex flex-col gap-5">
      {back ? <BackLink {...back} /> : null}
      <div className="flex items-center justify-between gap-6 flex-wrap">
        <div className="flex items-center gap-5 min-w-0">
          {icon ? <div className="card-header-icon">{icon}</div> : null}
          <div className="min-w-0">
            <div className="flex items-center gap-4 flex-wrap">
              <h1 className="text-lead font-bold">{title}</h1>
              {badges}
            </div>
            {description ? (
              <p className="mt-1 text-badge text-text-tertiary">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className={cn("flex items-center gap-4 flex-wrap min-w-0 max-w-full")}>
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
