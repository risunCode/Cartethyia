import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

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
    const variantClass = `btn-${variant}`;
    const labeled = size === "icon" && label !== undefined;
    const sizeClass = labeled
      ? "btn-labeled"
      : size === "sm"
        ? "btn-sm"
        : size === "icon"
          ? "btn-icon"
          : "";
    const renderedIcon = loading ? <Loader2 size={14} className="animate-spin" /> : icon;
    return (
      <button
        ref={ref}
        type={type}
        className={`btn ${variantClass} ${sizeClass} ${className}`.trim()}
        aria-busy={loading || undefined}
        {...props}
      >
        {renderedIcon ? (
          <span className="btn-icon-wrapper" aria-hidden="true">
            {renderedIcon}
          </span>
        ) : null}
        {labeled ? <span className="btn-label">{label}</span> : children}
      </button>
    );
  },
);

Button.displayName = "Button";
