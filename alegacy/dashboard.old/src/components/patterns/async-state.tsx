import type { ReactNode } from "react";
import { StatePanel, type StatePanelKind } from "../ui/state";

export interface AsyncStateProps {
  loading: boolean;
  error: boolean;
  empty?: boolean;
  loadingView?: ReactNode;
  errorView?: ReactNode;
  emptyView?: ReactNode;
  children: ReactNode;
}

/** Standardizes loading, error, and empty branches without hiding page semantics. */
export function AsyncState({ loading, error, empty = false, loadingView, errorView, emptyView, children }: AsyncStateProps) {
  if (loading) return <>{loadingView ?? <StatePanel kind="loading" />}</>;
  if (error) return <>{errorView ?? <StatePanel kind="error" />}</>;
  if (empty) return <>{emptyView ?? <StatePanel kind="empty" />}</>;
  return <>{children}</>;
}

/** Builds a compact state panel for callers that only need copy and an optional action. */
export function StateView({ kind, title, description, action }: { kind: StatePanelKind; title: string; description?: string; action?: ReactNode }) {
  return <StatePanel kind={kind} title={title} description={description} action={action} />;
}
