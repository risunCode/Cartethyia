import { useState } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input, Label } from "./ui/input";

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "default"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-[var(--text-2)]">{message}</p>
    </Dialog>
  );
}

/** dbAuth-style modal: sensitive actions re-confirm the active password. */
export function PasswordModal({
  open,
  onClose,
  onSubmit,
  title,
  description,
  busy,
  error,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (password: string) => void;
  title: string;
  description: string;
  busy?: boolean;
  error?: string | null;
  children?: React.ReactNode;
}) {
  const [password, setPassword] = useState("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || password.length === 0}
            onClick={() => {
              onSubmit(password);
              setPassword("");
            }}
          >
            {busy ? "Working…" : "Confirm"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-[var(--text-2)]">{description}</p>
      {children}
      <Label htmlFor="confirm-password">Password</Label>
      <Input
        id="confirm-password"
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && password) onSubmit(password);
        }}
      />
      {error && <p className="mt-2 text-xs font-medium text-[var(--red)]">{error}</p>}
    </Dialog>
  );
}
