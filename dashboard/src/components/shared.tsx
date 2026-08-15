/* @jsxImportSource solid-js */

import { createSignal, type JSX } from "solid-js";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input, Label } from "./ui/input";

export function ConfirmDialog(props: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: string; confirmLabel?: string; danger?: boolean;
}) {
  const confirm = () => { props.onConfirm(); props.onClose(); };
  return <Dialog open={props.open} onClose={props.onClose} title={props.title} footer={<><Button variant="secondary" onClick={props.onClose}>Cancel</Button><Button variant={props.danger ? "danger" : "default"} onClick={confirm}>{props.confirmLabel ?? "Confirm"}</Button></>}><p class="text-sm text-[var(--text-2)]">{props.message}</p></Dialog>;
}

/** dbAuth-style modal: sensitive actions re-confirm the active password. */
export function PasswordModal(props: {
  open: boolean; onClose: () => void; onSubmit: (password: string) => void; title: string; description: string; busy?: boolean; error?: string | null; children?: JSX.Element;
}) {
  const [password, setPassword] = createSignal("");
  const submit = () => { props.onSubmit(password()); setPassword(""); };
  return <Dialog open={props.open} onClose={props.onClose} title={props.title} footer={<><Button variant="secondary" onClick={props.onClose}>Cancel</Button><Button disabled={props.busy || password().length === 0} onClick={submit}>{props.busy ? "Working…" : "Confirm"}</Button></>}><p class="mb-3 text-sm text-[var(--text-2)]">{props.description}</p>{props.children}<Label htmlFor="confirm-password">Password</Label><Input id="confirm-password" type="password" autofocus value={password()} onInput={(event) => setPassword(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && password()) submit(); }} />{props.error ? <p class="mt-2 text-xs font-medium text-[var(--red)]">{props.error}</p> : null}</Dialog>;
}
