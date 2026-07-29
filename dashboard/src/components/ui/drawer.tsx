import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { duration, easeOut } from "../../lib/motion";

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  // Portalled for the same reason as Dialog — see the note there.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-90" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-md" onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-label={title}
            className="glass-2 absolute inset-x-2 top-2 bottom-2 flex w-auto min-w-0 flex-col rounded-2xl p-3 sm:inset-y-4 sm:right-4 sm:left-auto sm:w-full sm:max-w-md sm:p-5"
            initial={{ x: "105%" }}
            animate={{ x: 0 }}
            exit={{ x: "105%" }}
            transition={{ duration: duration.base, ease: easeOut }}
          >
            <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-base font-bold">{title}</h2>
              <button
                onClick={onClose}
                aria-label="Close"
                className="rounded-lg p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
              >
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
