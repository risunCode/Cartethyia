import { toast as sonnerToast, type ExternalToast } from "sonner";
import type { ReactNode } from "react";

type ToastMessage = ReactNode | (() => ReactNode);
type ToastMethod = (message: ToastMessage, data?: ExternalToast) => string | number;

function toastNodeToText(value: ToastMessage): string {
  if (typeof value === "function") return toastNodeToText(value());
  if (Array.isArray(value)) return value.map((item) => toastNodeToText(item)).filter(Boolean).join("\n");
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function toastContentToText(message: ToastMessage, description: ExternalToast["description"]): string {
  return [toastNodeToText(message), description === undefined ? "" : toastNodeToText(description)].filter(Boolean).join("\n");
}

function copyToastContent(message: ToastMessage, description: ExternalToast["description"]): void {
  const text = toastContentToText(message, description);
  if (!navigator.clipboard) {
    sonnerToast.error("Clipboard unavailable");
    return;
  }
  void navigator.clipboard.writeText(text).then(
    () => sonnerToast.success("Toast content copied", { duration: 2_000 }),
    () => sonnerToast.error("Copy failed", { duration: 2_000 }),
  );
}

function withCopyAction(message: ToastMessage, data?: ExternalToast): ExternalToast {
  const copyAction = {
    label: "Copy",
    onClick: () => copyToastContent(message, data?.description),
  };
  if (data?.action !== undefined) return { ...data, cancel: copyAction };
  return { ...data, action: copyAction };
}

function createToastMethod(method: ToastMethod): ToastMethod {
  return (message, data) => method(message, withCopyAction(message, data));
}

export const toast = {
  success: createToastMethod(sonnerToast.success),
  error: createToastMethod(sonnerToast.error),
  dismiss: () => sonnerToast.dismiss(),
};
