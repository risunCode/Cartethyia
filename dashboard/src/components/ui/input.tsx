import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/classnames";

/*
 * The shared field box. `form-input` / `form-textarea` stay as markers because
 * the sheets and several descendant rules (`.data-table .form-input`, the setup
 * table) still select on them; the box itself is utilities.
 */
const FIELD =
  "w-full rounded-control border border-inner-border bg-surface-2 text-text-primary px-6 py-4 text-body outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus";

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
      <div className="form-group flex w-full flex-col gap-3">
        {label ? (
          <label htmlFor={id} className="form-label flex items-center justify-between text-caption font-semibold text-text-primary">
            <span>{label}</span>
            {hint ? <span className="form-hint text-badge font-normal text-text-tertiary">{hint}</span> : null}
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
          <p className="form-error mt-2 text-badge text-red" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Input.displayName = "Input";

/** Native picker chrome shares the field tokens; callers own file validation. */
export const FileInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="file"
      className={cn(
        "form-file-input box-border min-w-0 h-16 flex-auto cursor-pointer rounded-control border border-inner-border bg-surface-2 py-0 pl-0 pr-2 font-sans text-badge text-text-secondary transition-colors duration-(--dur-micro) ease-standard enabled:hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-60",
        "file:h-full file:mr-4 file:px-5 file:py-0 file:rounded-l-control file:rounded-r-none file:border-0 file:border-r file:border-inner-border file:bg-surface-1 file:font-sans file:text-badge file:font-semibold file:text-text-primary file:cursor-pointer disabled:file:cursor-not-allowed file:hover:bg-surface-hover",
        className,
      )}
      {...props}
    />
  ),
);
FileInput.displayName = "FileInput";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, hint, error, id, className = "", ...props }, ref) => {
    return (
      <div className="form-group flex w-full flex-col gap-3">
        {label ? (
          <label htmlFor={id} className="form-label flex items-center justify-between text-caption font-semibold text-text-primary">
            <span>{label}</span>
            {hint ? <span className="form-hint text-badge font-normal text-text-tertiary">{hint}</span> : null}
          </label>
        ) : null}
        <textarea
          ref={ref}
          id={id}
          className={cn("form-textarea", FIELD, className)}
          {...props}
        />
        {error ? (
          <p className="form-error mt-2 text-badge text-red" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
