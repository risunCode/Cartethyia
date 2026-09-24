import type { ReactNode } from "react";
import { Inbox, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "./button";

export function EmptyState({
  title,
  message,
  icon,
  action,
}: {
  title: string;
  message: string;
  /** Defaults to an inbox glyph; pass one to name the specific empty thing. */
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state-viewport">
      <div className="state-box">
        <div className="state-box-icon" aria-hidden="true">
          {icon ?? <Inbox size={20} />}
        </div>
        <h3>{title}</h3>
        <p>{message}</p>
        {action ? <div style={{ marginTop: "8px" }}>{action}</div> : null}
      </div>
    </div>
  );
}

export function LoadingState({ label = "Loading data…" }: { label?: string }) {
  return (
    <div className="state-viewport">
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
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="state-viewport">
      <div className="state-box">
        <div className="state-box-icon state-box-icon-danger" aria-hidden="true">
          <TriangleAlert size={20} />
        </div>
        <h3 style={{ color: "var(--red)" }}>{title}</h3>
        <p role="alert">{message}</p>
        {action ? <div style={{ marginTop: "8px" }}>{action}</div> : null}
        {onRetry ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            style={{ marginTop: "6px" }}
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
  const style = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: fill ? "0" : undefined,
    flex: fill ? 1 : undefined,
    padding: padding === "sm" ? "20px" : "32px",
  };
  if (kind === "loading") {
    return <div className={className} style={style}><LoadingState label={description || title || "Loading…"} /></div>;
  }
  if (kind === "error") {
    return <div className={className} style={style}><ErrorState title={title || "Unable to load data"} message={description || "Check the console session and retry."} action={action} /></div>;
  }
  return <div className={className} style={style}><EmptyState title={title || "Nothing here yet"} message={description || "There is no data to show."} action={action} /></div>;
}
