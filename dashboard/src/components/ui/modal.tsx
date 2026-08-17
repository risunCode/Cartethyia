
import { createSignal, type JSX } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { Maximize2, Minus, X } from "lucide-solid";
import { focusRingClasses } from "./styles";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: JSX.Element;
  footer?: JSX.Element;
  wide?: boolean;
}

/**
 * Modal dialog built on Kobalte Dialog with macOS traffic-light window controls
 * (close / minimize / expand). Fully accessible with focus trapping, Escape close,
 * and animated enter/exit via CSS [data-expanded]/[data-closed] attributes.
 */
export function Modal(props: ModalProps): JSX.Element {
  const [minimized, setMinimized] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-90 flex items-center justify-center p-4" />
        <Dialog.Content
          class={`glass-2 relative flex w-full flex-col ${
            expanded() ? "max-w-4xl max-h-[95vh]" : props.wide ? "max-w-2xl max-h-[85vh]" : "max-w-md max-h-[85vh]"
          } rounded-2xl p-5 outline-none`}
        >
          <div class="mb-3 flex shrink-0 items-center gap-3 border-b border-[var(--inner-border)] pb-3">
            <div class="flex items-center gap-2" role="group" aria-label="Window controls">
              <button
                type="button"
                onClick={() => props.onOpenChange(false)}
                aria-label="Close dialog"
                title="Close"
                class={"grid size-3.5 place-items-center rounded-full bg-[#ff5f57] text-[#7a1c17] transition-transform hover:scale-110 " + focusRingClasses}
              >
                <X size={9} strokeWidth={2.5} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setMinimized((v) => !v)}
                aria-label={minimized() ? "Restore dialog" : "Minimize dialog"}
                title={minimized() ? "Restore" : "Minimize"}
                class={"grid size-3.5 place-items-center rounded-full bg-[#febc2e] text-[#6d4b00] transition-transform hover:scale-110 " + focusRingClasses}
              >
                <Minus size={9} strokeWidth={2.5} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => { setExpanded((v) => !v); setMinimized(false); }}
                aria-label={expanded() ? "Restore dialog size" : "Expand dialog"}
                title={expanded() ? "Restore" : "Expand"}
                class={"grid size-3.5 place-items-center rounded-full bg-[#28c840] text-[#0b5a22] transition-transform hover:scale-110 " + focusRingClasses}
              >
                <Maximize2 size={8} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
            <Dialog.Title class="min-w-0 flex-1 truncate text-center text-base font-bold">
              {props.title}
            </Dialog.Title>
            <span class="w-[3.75rem]" aria-hidden="true" />
          </div>

          {!minimized() && (
            <>
              <div class="min-w-0 flex-1 overflow-y-auto">{props.children}</div>
              {props.footer && <div class="mt-4 flex justify-end gap-2">{props.footer}</div>}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
