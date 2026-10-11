import type { ReactNode } from "react";

export interface FormFieldProps {
  readonly label?: string;
  /** Trailing note on the label line, right-aligned by `.form-label`. */
  readonly hint?: string;
  readonly error?: string;
  /** The control's `id`, so the label is wired to it. */
  readonly htmlFor?: string;
  readonly children: ReactNode;
}

/**
 * The label / control / error scaffold every form field shares.
 *
 * `.form-group`, `.form-label`, `.form-hint` and `.form-error` are marker classes
 * with the declarations in `styles/base.css`; this names the composition once so
 * `Select` and the panels that hand-roll a labelled control stop re-declaring it.
 * `Input`/`Textarea` keep their own markup because the password toggle is woven
 * into the control row, but they emit the same four classes.
 */
export function FormField({ label, hint, error, htmlFor, children }: FormFieldProps): ReactNode {
  return (
    <div className="form-group">
      {label ? (
        <label className="form-label" htmlFor={htmlFor}>
          {label}
          {hint ? <span className="form-hint">{hint}</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
