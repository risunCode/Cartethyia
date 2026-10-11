import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The dashboard's role-based type scale, `text-*` tokens from `styles/tokens.css`.
 *
 * `tailwind-merge` ships a fixed theme and treats any `text-<name>` it does not
 * recognise as a *colour*, so `cn("text-badge", "text-text-secondary")` dropped
 * the size: both looked like `text-color` to the merge, and the second won. The
 * size then vanished from the DOM with no typecheck, test, or build error — a
 * `text-badge` next to a colour utility rendered at the inherited size. Teaching
 * the merge the role names is what keeps the two axes separate.
 */
const ROLE_TYPE_SCALE = [
  "micro",
  "badge",
  "caption",
  "body",
  "body-lg",
  "lead",
  "title",
  "display",
  "hero",
] as const;

/** Merges conditional class names, letting a caller's utilities win over the
 *  component's own. Every `ui/` primitive composes through this. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...ROLE_TYPE_SCALE] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
