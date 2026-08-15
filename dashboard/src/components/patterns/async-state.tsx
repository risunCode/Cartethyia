/* @jsxImportSource solid-js */

import { Show, type JSX } from "solid-js";
import { StatePanel, type StatePanelKind } from "../ui/state";

export interface AsyncStateProps {
  loading: boolean;
  error: boolean;
  empty?: boolean;
  loadingView?: JSX.Element;
  errorView?: JSX.Element;
  emptyView?: JSX.Element;
  children: JSX.Element;
}

/** Standardizes loading, error, and empty branches without hiding page semantics. */
export function AsyncState(props: AsyncStateProps): JSX.Element {
  return (
    <Show when={props.loading} fallback={
      <Show when={props.error} fallback={
        <Show when={props.empty} fallback={props.children}>
          {props.emptyView ?? <StatePanel kind="empty" />}
        </Show>
      }>
        {props.errorView ?? <StatePanel kind="error" />}
      </Show>
    }>
      {props.loadingView ?? <StatePanel kind="loading" />}
    </Show>
  );
}

/** Builds a compact state panel for callers that only need copy and an optional action. */
export function StateView(props: { kind: StatePanelKind; title: string; description?: string; action?: JSX.Element }): JSX.Element {
  return <StatePanel kind={props.kind} title={props.title} description={props.description} action={props.action} />;
}
