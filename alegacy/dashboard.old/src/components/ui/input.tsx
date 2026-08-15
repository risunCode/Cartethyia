import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

const base =
  "w-full rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] outline-none transition-colors duration-150 focus:border-[var(--accent)] focus:bg-[var(--glass-bg-2)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(base, className)} {...props} />
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(base, "min-h-20 resize-y", className)} {...props} />
);
Textarea.displayName = "Textarea";

export function Label({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold text-[var(--text-2)]">
      {children}
    </label>
  );
}
