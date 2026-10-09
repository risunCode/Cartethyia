import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
  /**
   * Text shown beside the icon for a `size="icon"` button. The label collapses
   * away (leaving the square icon button) when the surrounding `@container`
   * is too narrow, so dense toolbars stay readable without overflowing.
   */
  label?: string;
}

/*
 * The `btn*` tokens below are marker classes, not styling: two contracts still
 * select on them. `primitives.test.tsx` pins the emitted DOM, and the
 * `@container rule-row` collapse in base.css hides `.btn-label` when the row is
 * narrow — a container query cannot be expressed as a utility here because the
 * queried container is the caller's, not the button's. Everything visual is a
 * utility; `twMerge` would strip the markers if they collided, so they are
 * emitted through `cn` as plain strings.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: "btn-primary bg-accent text-accent-foreground shadow-[0_2px_8px_color-mix(in_srgb,var(--accent)_25%,transparent)] hover:bg-accent-hover",
  secondary: "btn-secondary border border-inner-border bg-hover text-text-primary hover:bg-active-pill hover:border-border-strong",
  ghost: "btn-ghost text-text-secondary hover:bg-hover hover:text-text-primary",
  danger: "btn-danger bg-red text-white hover:opacity-90",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "btn-sm h-[30px] px-[10px] text-[11.5px] [&_svg]:size-[13px]",
  md: "",
  lg: "",
  icon: "btn-icon size-[34px] p-0 grid place-items-center [&_svg]:size-[15px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className = "",
      variant = "secondary",
      size = "md",
      icon,
      label,
      loading = false,
      children,
      type = "button",
      ...props
    },
    ref,
  ) => {
    const labeled = size === "icon" && label !== undefined;
    const renderedIcon = loading ? <Loader2 size={14} className="animate-spin" /> : icon;
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "btn inline-flex items-center justify-center gap-[7px] rounded-control font-semibold text-[12.5px] px-[14px] py-2 transition-all active:scale-[0.97]",
          VARIANT[variant],
          labeled
            ? "btn-labeled h-[30px] px-[10px] gap-[6px] text-[11.5px] [&_svg]:size-[13px]"
            : SIZE[size],
          className,
        )}
        aria-busy={loading || undefined}
        {...props}
      >
        {renderedIcon ? (
          <span className="btn-icon-wrapper inline-flex items-center" aria-hidden="true">
            {renderedIcon}
          </span>
        ) : null}
        {labeled ? <span className="btn-label">{label}</span> : children}
      </button>
    );
  },
);

Button.displayName = "Button";
