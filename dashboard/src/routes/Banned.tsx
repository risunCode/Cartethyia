import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

export default function Banned(): ReactNode {
  return (
    <main className="auth-viewport">
      <div className="card-solid auth-window" style={{ border: "1px solid var(--red-soft)" }}>
        <div className="auth-header">
          <div className="auth-logo" style={{ background: "var(--red)" }} aria-hidden="true">
            <ShieldAlert size={24} />
          </div>
          <h1 className="auth-title">Access Restricted</h1>
          <p className="auth-desc">Security policy lockout or untrusted origin address</p>
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
            HTTP 403 Forbidden
          </strong>
          This client IP has been temporarily locked out due to repeated invalid credential attempts
          or untrusted proxy headers.
        </div>
      </div>
    </main>
  );
}
