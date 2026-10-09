import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges conditional class names, letting a caller's utilities win over the
 *  component's own. Every `ui/` primitive composes through this. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
