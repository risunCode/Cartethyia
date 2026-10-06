import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { getErrorMessage } from "../lib/helpers";

/**
 * Shared destructive-confirmation contract.
 *
 * `onConfirm` may be async: the dialog stays open with a pending confirm
 * button while it settles, closes only after success, and surfaces a
 * rejection as a visible inline error instead of closing. Callers should pass
 * `mutateAsync` wrappers (with success toasts) rather than fire-and-forget
 * `mutate` calls so failures are never swallowed.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<unknown>;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setError(null);
      setPending(false);
    }
  }, [open ]);

  const confirm = () => {
    if (pending) return;
    setError(null);
    setPending(true);
    void Promise.resolve()
      .then(() => onConfirm())
      .then(() => onClose())
      .catch((err: unknown) => {
        setError(getErrorMessage(err, "Action failed. Please try again."));
        setPending(false);
      });
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} description={message}>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "4px 0" }}>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {message}
        </p>
        {error ? (
          <p role="alert" style={{ fontSize: "12px", color: "var(--red)" }}>
            {error}
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            onClick={confirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
