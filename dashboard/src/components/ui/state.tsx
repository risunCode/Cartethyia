import type { ReactNode } from "react";
import { Inbox, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "./button";

/**
 * A state nested in a dialog or a card must not reserve the route-level
 * centering floor (`.state-viewport` is 220px tall), which would balloon a
 * compact panel into mostly empty space. `compact` keeps the same markup and
 * semantics with the floor removed.
 */
function viewportClass(compact: boolean | undefined): string {
  return cn(
    "state-viewport flex-1 min-h-110 flex items-center justify-center w-full",
    compact === true && "state-viewport-compact min-h-0 py-2 px-0 [&_.state-box]:gap-3 [&_.state-box]:py-4 [&_.state-box-icon]:size-15",
  );
}

export function EmptyState({
  title,
  message,
  icon,
  action,
  compact,
}: {
  title: string;
  message: string;
  /** Defaults to an inbox glyph; pass one to name the specific empty thing. */
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={viewportClass(compact)}>
      <div className="state-box">
        <div className="state-box-icon" aria-hidden="true">
          {icon ?? <Inbox size={20} />}
        </div>
        <h3>{title}</h3>
        <p>{message}</p>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading data…", compact }: { label?: string; compact?: boolean }) {
  return (
    <div className={viewportClass(compact)}>
      <div className="state-box">
        <div className="state-box-icon" aria-hidden="true">
          <Loader2 size={20} className="animate-spin" />
        </div>
        <p className="state-box-label" role="status" aria-live="polite">
          {label}
        </p>
      </div>
    </div>
  );
}

export function ErrorState({
  title = "Unable to load data",
  message,
  onRetry,
  retrying = false,
  action,
  compact,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={viewportClass(compact)}>
      <div className="state-box">
        <div className="state-box-icon state-box-icon-danger" aria-hidden="true">
          <TriangleAlert size={20} />
        </div>
        <h3 className="!text-red">{title}</h3>
        <p role="alert">{message}</p>
        {action ? <div className="mt-4">{action}</div> : null}
        {onRetry ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            className="mt-3"
          >
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function StatePanel({
  kind,
  title,
  description,
  action,
  className = "",
  padding = "md",
  fill = false,
}: {
  kind: "loading" | "empty" | "error";
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  padding?: "sm" | "md";
  fill?: boolean;
}) {
  const host = cn(
    "flex items-center justify-center",
    fill && "min-h-0 flex-1",
    padding === "sm" ? "p-10" : "p-16",
    className,
  );
  if (kind === "loading") {
    return (
      <div className={host}>
        <LoadingState label={description || title || "Loading…"} />
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className={host}>
        <ErrorState
          title={title || "Unable to load data"}
          message={description || "Check the console session and retry."}
          action={action}
        />
      </div>
    );
  }
  return (
    <div className={host}>
      <EmptyState
        title={title || "Nothing here yet"}
        message={description || "There is no data to show."}
        action={action}
      />
    </div>
  );
}
