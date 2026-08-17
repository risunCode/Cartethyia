
import type { JSX } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { X } from "lucide-solid";
import { focusRingClasses } from "./styles";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: JSX.Element;
}

/**
 * Right-side modal drawer built on Kobalte Dialog.
 * Slides in from the right with CSS animation via the .kb-drawer-panel class.
 * Full-width on mobile, max-w-md on desktop. Escape-to-close, focus trapped.
 */
export function Drawer(props: DrawerProps): JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-90" />
        <Dialog.Content
          class="kb-drawer-panel glass-2 absolute inset-x-2 top-2 bottom-2 flex w-auto min-w-0 flex-col rounded-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] overscroll-contain outline-none sm:inset-y-4 sm:right-4 sm:left-auto sm:w-full sm:max-w-md sm:p-5"
        >
          <div class="mb-3 flex min-w-0 items-center justify-between gap-3">
            <Dialog.Title class="min-w-0 truncate text-base font-bold">
              {props.title}
            </Dialog.Title>
            <button
              type="button"
              onClick={() => props.onOpenChange(false)}
              aria-label="Close drawer"
              class={"rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)] " + focusRingClasses}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
            {props.children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
