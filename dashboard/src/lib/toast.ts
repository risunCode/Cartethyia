import { toast as sonnerToast, type ExternalToast } from "sonner";

/** Builds a "Copy" action that puts the toast's title + description on the clipboard. */
function withCopyAction(title: string, description?: string | null): ExternalToast {
  const text = [title, description].filter((value): value is string => Boolean(value)).join("\n");
  return {
    ...(description ? { description } : {}),
    action: {
      label: "Copy",
      onClick: () => {
        if (!navigator.clipboard) {
          sonnerToast.error("Clipboard unavailable");
          return;
        }
        void navigator.clipboard.writeText(text).then(
          () => sonnerToast.success("Toast content copied", { duration: 2_000 }),
          () => sonnerToast.error("Copy failed", { duration: 2_000 }),
        );
      },
    },
  };
}

export const toast = {
  success: (title: string, description?: string | null) =>
    sonnerToast.success(title, withCopyAction(title, description)),
  error: (title: string, description?: string | null) =>
    sonnerToast.error(title, withCopyAction(title, description)),
  dismiss: (id?: string | number) => sonnerToast.dismiss(id),
};
