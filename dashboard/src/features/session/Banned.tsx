import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

export default function Banned(): ReactNode {
  return (
    <main className="auth-viewport">
      <div className="card-solid auth-window border border-red-soft">
        <div className="auth-header">
          {/*
            `.auth-logo` paints the favicon through the `background` shorthand, so
            `bg-red` alone would only swap the colour and leave the image showing.
            `bg-none` restores what the shorthand used to reset.
          */}
          <div aria-hidden="true" className="auth-logo bg-red bg-none">
            <ShieldAlert size={24} />
          </div>
          <h1 className="auth-title">Access Restricted</h1>
          <p className="auth-desc">Security policy lockout or untrusted origin address</p>
        </div>

        {/* Same panel the error boundary raises: radius, surface, border, body type. */}
        <div className="rounded-panel border border-inner-border bg-surface-2 p-7 text-caption leading-relaxed text-text-secondary">
          <strong className="block text-text-primary mb-2">
            HTTP 403 Forbidden
          </strong>
          This client IP has been temporarily locked out due to repeated invalid credential attempts
          or untrusted proxy headers.
        </div>
      </div>
    </main>
  );
}
