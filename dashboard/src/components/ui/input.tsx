import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

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
        <div style={{ position: "relative", display: "flex", alignItems: "center", width: "100%" }}>
          <input
            ref={ref}
            id={id}
            type={actualType}
            className={`form-input ${className}`.trim()}
            style={allowToggle ? { paddingRight: "36px" } : undefined}
            {...props}
          />
          {allowToggle ? (
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "Hide password" : "Show password"}
              aria-pressed={visible}
              style={{
                position: "absolute",
                right: "10px",
                background: "transparent",
                border: "none",
                color: "var(--text-tertiary)",
                cursor: "pointer",
                padding: "2px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
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
        <textarea ref={ref} id={id} className={`form-textarea ${className}`.trim()} {...props} />
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
