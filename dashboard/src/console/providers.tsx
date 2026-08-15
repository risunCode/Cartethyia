/* @jsxImportSource solid-js */

import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { For, Show, type JSX } from "solid-js";
import { ThemeProvider } from "../lib/theme";
import { getToastRecords, toast, toastNodeToText, type ToastRecord } from "../lib/toast";


export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false, refetchIntervalInBackground: false, gcTime: 5 * 60_000 },
  },
});


export function Providers(props: { children: JSX.Element }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {props.children}
        <ToastViewport />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function ToastViewport() {
  const records = getToastRecords;
  return <aside class="pointer-events-none fixed top-6 right-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
    <For each={records()}>{(record: ToastRecord) => <article class={`toast-surface pointer-events-auto rounded-[14px] border border-[var(--glass-border)] bg-[var(--surface)] p-3 shadow-xl ${record.className ?? ""}`}>
      <div class="flex items-start gap-3"><div class="min-w-0 flex-1"><p class="text-[13px] font-semibold text-[var(--text-1)]">{toastNodeToText(record.message)}</p><Show when={record.description}><p class="mt-1 text-[12px] text-[var(--text-2)]">{toastNodeToText(record.description!)}</p></Show></div><button type="button" class="text-[var(--text-3)] hover:text-[var(--text-1)]" onClick={() => toast.dismiss(record.id)} aria-label="Dismiss notification">×</button></div>
      <div class="mt-2 flex justify-end gap-2"><Show when={record.cancel}><button type="button" class="rounded px-2 py-1 text-[11px] text-[var(--text-2)] hover:bg-[var(--hover)]" onClick={() => { record.cancel?.onClick(); toast.dismiss(record.id); }}>{record.cancel?.label}</button></Show><Show when={record.action}><button type="button" class="rounded bg-[var(--accent)] px-2 py-1 text-[11px] font-semibold text-[var(--accent-foreground)]" onClick={() => { record.action?.onClick(); toast.dismiss(record.id); }}>{record.action?.label}</button></Show></div>
    </article>}</For>
  </aside>;
}
