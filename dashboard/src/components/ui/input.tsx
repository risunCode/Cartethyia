/* @jsxImportSource solid-js */

import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/cn";

const base =
  "w-full rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] outline-none transition-colors duration-150 focus:border-[var(--accent)] focus:bg-[var(--glass-bg-2)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]";

export interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

/** A themed text input with a forwarded Solid ref and native input attributes. */
export function Input(props: InputProps): JSX.Element {
  const [local, rest] = splitProps(props, ["className"]);
  return <input {...rest} class={cn(base, local.className)} />;
}

export interface TextareaProps extends JSX.TextareaHTMLAttributes<HTMLTextAreaElement> {
  className?: string;
}

/** A themed textarea with the same focus treatment as Input. */
export function Textarea(props: TextareaProps): JSX.Element {
  const [local, rest] = splitProps(props, ["className"]);
  return <textarea {...rest} class={cn(base, "min-h-20 resize-y", local.className)} />;
}

export interface LabelProps {
  children: JSX.Element;
  htmlFor?: string;
}

/** A compact form label matching the dashboard control scale. */
export function Label(props: LabelProps): JSX.Element {
  return <label for={props.htmlFor} class="mb-1.5 block text-xs font-semibold text-[var(--text-2)]">{props.children}</label>;
}
