import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/*
 * The shared field box. `form-input` / `form-textarea` stay as markers because
 * the sheets and several descendant rules (`.data-table .form-input`, the setup
 * table) still select on them; the box itself is utilities.
 */
const FIELD =
  "w-full rounded-control border border-inner-border bg-surface-2 text-text-primary px-6 py-4 text-body outline-none transition-[border-color,box-shadow] duration-[var(--dur-micro)] ease-[var(--ease-spring)] focus:border-accent focus:shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_15%,transparent)]";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  showPasswordToggle?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, id, type, className = "", showPasswordToggle, ...props }, ref) => {
    const isPassword = type === "password";
    const allowToggle = isPassword || showPasswordToggle;
    const [visible, setVisible] = useState(false);
    const actualType = isPassword ? (visible ? "text" : "password") : type;

    return (
      <div className="form-group">
        {label ? (
          <label htmlFor={id} className="form-label">
            <span>{label}</span>
            {hint ? <span className="form-hint">{hint}</span> : null}
          </label>
        ) : null}
        <div className="relative flex items-center w-full">
          <input
            ref={ref}
            id={id}
            type={actualType}
            className={cn("form-input", FIELD, allowToggle && "pr-18", className)}
            {...props}
          />
          {allowToggle ? (
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "Hide password" : "Show password"}
              aria-pressed={visible}
              className="absolute right-5 bg-transparent border-none text-text-tertiary cursor-pointer p-1 inline-flex items-center justify-center"
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Input.displayName = "Input";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, hint, error, id, className = "", ...props }, ref) => {
    return (
      <div className="form-group">
        {label ? (
          <label htmlFor={id} className="form-label">
            <span>{label}</span>
            {hint ? <span className="form-hint">{hint}</span> : null}
          </label>
        ) : null}
        <textarea
          ref={ref}
          id={id}
          className={cn("form-textarea", FIELD, className)}
          {...props}
        />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
