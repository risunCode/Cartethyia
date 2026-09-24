import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** Distinguishes navigation targets. A change clears a recovered error so a
   * transient lazy-chunk load failure at one route never pins the whole shell
   * to the error surface when the user navigates elsewhere. */
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Root error boundary for the console shell. Lazy route imports can fail on a
 * transient chunk fetch; rather than leaving a blank viewport the boundary
 * renders a recoverable surface and offers a full reload as the last resort.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[console] route render failed:", error, info.componentStack);
  }

  override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <main className="auth-viewport">
        <div className="card-solid auth-window" style={{ border: "1px solid var(--red-soft)" }}>
          <div className="auth-header">
            <h1 className="auth-title">Console view failed</h1>
            <p className="auth-desc">This view could not be rendered.</p>
          </div>

          <div
            style={{
              padding: "14px",
              borderRadius: "12px",
              background: "var(--surface-2)",
              border: "1px solid var(--inner-border)",
              fontSize: "12.5px",
              color: "var(--text-secondary)",
              lineHeight: 1.5,
            }}
          >
            <strong style={{ display: "block", color: "var(--text-primary)", marginBottom: "4px" }}>
              Rendering error
            </strong>
            <span className="select-text" style={{ wordBreak: "break-word" }}>
              {this.state.error.message}
            </span>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            style={{ width: "100%", marginTop: "6px", height: "40px" }}
            onClick={() => window.location.reload()}
          >
            Reload console
          </button>
        </div>
      </main>
    );
  }
}