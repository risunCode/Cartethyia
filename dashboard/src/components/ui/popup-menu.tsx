
import type { JSX } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { cn } from "../../lib/cn";
import { disabledControlClasses, focusRingClasses } from "./styles";
import { Dropdown, type DropdownProps } from "./dropdown";

export interface PopupMenuItem {
  id: string;
  label: string;
  onSelect?: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  danger?: boolean;
}

export interface PopupMenuProps {
  open: boolean;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
  trigger: DropdownProps["trigger"];
  items: readonly PopupMenuItem[];
  id?: string;
  align?: DropdownProps["align"];
  ariaLabel?: string;
  className?: string;
  onExited?: () => void;
}

/** A keyboard-friendly menu built on the shared dropdown lifecycle. */
export function PopupMenu(props: PopupMenuProps): JSX.Element {
  return (
    <Dropdown
      open={props.open}
      onClose={props.onClose}
      onOpenChange={props.onOpenChange}
      onExited={props.onExited}
      trigger={props.trigger}
      id={props.id}
      align={props.align}
      ariaLabel={props.ariaLabel ?? "Popup menu"}
      className={props.className}
    >
      <div role="none">
        {props.items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect?.();
                props.onClose();
              }}
              class={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-[var(--text-1)] transition-colors hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)]",
                disabledControlClasses,
                focusRingClasses,
                item.danger && "text-[var(--status-danger)] hover:bg-[var(--red-soft)] focus-visible:bg-[var(--red-soft)]",
              )}
            >
              {Icon && <Icon size={14} aria-hidden="true" />}
              <span class="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          );
        })}
      </div>
    </Dropdown>
  );
}
