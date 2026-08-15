/* @jsxImportSource solid-js */

import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/cn";

export type ButtonVariant = "default" | "secondary" | "ghost" | "danger" | "outline";
export type ButtonSize = "sm" | "md" | "icon";

const variants: Record<ButtonVariant, string> = {
  default: "bg-[var(--accent)] text-white hover:opacity-90",
  secondary: "bg-[var(--hover)] text-[var(--text-1)] border border-[var(--inner-border)] hover:bg-[var(--active-pill)]",
  ghost: "text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text-1)]",
  danger: "bg-[var(--red)] text-white hover:opacity-90",
  outline: "border border-[var(--inner-border)] text-[var(--text-1)] hover:bg-[var(--hover)]",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
  icon: "h-9 w-9",
};

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** A themed button that preserves native button semantics and keyboard behavior. */
export function Button(props: ButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["className", "variant", "size"]);
  return (
    <button
      {...rest}
      class={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-control)] font-medium transition-[color,background-color,border-color,opacity,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
        variants[local.variant ?? "default"],
        sizes[local.size ?? "md"],
        local.className,
      )}
    />
  );
}
