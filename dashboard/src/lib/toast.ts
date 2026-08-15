import { createSignal, type JSX } from "solid-js";

/** Solid-native toast content supporting text, nodes, functions, and arrays. */
export type ToastMessage = JSX.Element | (() => ToastMessage) | readonly ToastMessage[];
export type ToastId = string | number;
export type ToastKind = "success" | "error";

export interface ToastAction {
  label: string;
  onClick: (event?: MouseEvent) => void;
}

export interface ToastOptions {
  description?: ToastMessage;
  duration?: number;
  id?: ToastId;
  action?: ToastAction;
  cancel?: ToastAction;
  className?: string;
}

export interface ToastRecord {
  readonly id: ToastId;
  readonly kind: ToastKind;
  readonly message: ToastMessage;
  readonly description?: ToastMessage;
  readonly action?: ToastAction;
  readonly cancel?: ToastAction;
  readonly duration: number;
  readonly className?: string;
}

const MAX_VISIBLE_TEXT_LENGTH = 240;
const DEFAULT_DURATION = 5_000;
const MAX_DURATION = 30_000;
let nextToastId = 0;
const timers = new Map<ToastId, number>();
const [toastRecords, setToastRecords] = createSignal<readonly ToastRecord[]>([]);

function boundedText(value: string): string {
  const normalized = value.trim();
  return normalized.length <= MAX_VISIBLE_TEXT_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_VISIBLE_TEXT_LENGTH - 1)}…`;
}

/** Converts message content to safe clipboard/plain-text content without exposing object internals. */
export function toastNodeToText(value: ToastMessage): string {
  if (typeof value === "function") return toastNodeToText(value());
  if (Array.isArray(value)) return value.map(toastNodeToText).filter(Boolean).join("\n");
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return boundedText(String(value));
  return "";
}

export function toastContentToText(message: ToastMessage, description?: ToastMessage): string {
  return boundedText([toastNodeToText(message), description === undefined ? "" : toastNodeToText(description)]
    .filter(Boolean)
    .join("\n"));
}

function boundedDuration(duration: number | undefined): number {
  if (duration === Infinity) return Infinity;
  if (duration === undefined || !Number.isFinite(duration)) return DEFAULT_DURATION;
  return Math.max(1_000, Math.min(MAX_DURATION, Math.trunc(duration)));
}

function normalizeAction(action: ToastAction | undefined): ToastAction | undefined {
  if (action === undefined) return undefined;
  return { ...action, label: boundedText(action.label) };
}

function dismissRecord(id: ToastId): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  setToastRecords((records) => records.filter((record) => record.id !== id));
}

function enqueue(kind: ToastKind, message: ToastMessage, data?: ToastOptions, includeCopyAction = true): ToastId {
  const id = data?.id ?? `${kind}-${++nextToastId}`;
  dismissRecord(id);
  const action = normalizeAction(data?.action);
  const copyAction: ToastAction = {
    label: "Copy",
    onClick: () => copyToastContent(message, data?.description),
  };
  const record: ToastRecord = {
    id,
    kind,
    message,
    description: data?.description,
    action: includeCopyAction ? action ?? copyAction : action,
    cancel: includeCopyAction ? (action === undefined ? normalizeAction(data?.cancel) : copyAction) : normalizeAction(data?.cancel),
    duration: boundedDuration(data?.duration),
    className: data?.className,
  };
  setToastRecords((records) => [...records.filter((current) => current.id !== id), record].slice(-3));
  if (record.duration !== Infinity) timers.set(id, window.setTimeout(() => dismissRecord(id), record.duration));
  return id;
}

function copyToastContent(message: ToastMessage, description?: ToastMessage): void {
  const text = boundedText(toastContentToText(message, description));
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
    enqueue("error", "Clipboard unavailable", undefined, false);
    return;
  }
  void navigator.clipboard.writeText(text).then(
    () => enqueue("success", "Toast content copied", { duration: 2_000 }, false),
    () => enqueue("error", "Copy failed", { duration: 2_000 }, false),
  );
}

export const toast = {
  success: (message: ToastMessage, data?: ToastOptions): ToastId => enqueue("success", message, data),
  error: (message: ToastMessage, data?: ToastOptions): ToastId => enqueue("error", message, data),
  dismiss: (id?: ToastId): void => {
    if (id === undefined) {
      for (const current of timers.keys()) dismissRecord(current);
      setToastRecords([]);
      return;
    }
    dismissRecord(id);
  },
};

/** Reactive accessor consumed by the Solid console's toast viewport. */
export function getToastRecords(): readonly ToastRecord[] {
  return toastRecords();
}
