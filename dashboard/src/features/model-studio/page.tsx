/**
 * Model Studio — console-side chat playground. Every send goes through the
 * exact same `dispatchQualifiedRoute` pipeline real /v1/* traffic uses
 * (combos, stored-account rotation, configured system-prompt injection), so
 * a test here reflects production behavior. Sessions (model, system prompt,
 * message history) are saved server-side so switching sessions resends the
 * same message prefix — which is what lets provider prompt caching kick in
 * across turns instead of restarting cold every time.
 */

import { isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Boxes,
  Brain,
  Check,
  ChevronDown,
  Copy,
  ImagePlus,
  Info,
  Loader2,
  MessageSquareText,
  Pencil,
  Plus,
  Search,
  Send,
  Square,
  Trash2,
  User,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { ApiError, apiGet, apiPatch, apiPost, apiDelete } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input, Textarea } from "../../components/ui/input";
import { Select } from "../../components/ui/tabs";
import { ConfirmDialog } from "../../components/shared";
import { ProviderIcon } from "../../components/provider-icon";
import { useProviders, useModelCatalog, useCombos, useAliases, useCustomProviders, useCustomProviderCatalog, type ProviderSummary, type FlatModelEntry } from "../../components/model-picker";

interface StudioMessage {
  role: "system" | "user" | "assistant";
  content: string;
  ts: string;
  /** Reasoning/thinking text, if the model streamed any — client-side only, never persisted. */
  reasoning?: string;
  /** Data-URL image attachments (user turns only) — persisted with the session. */
  images?: string[];
}

interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

/** Attachment pending send — separate id so a chip can be removed before it becomes part of a message. */
interface PendingAttachment {
  id: string;
  dataUrl: string;
  name: string;
}

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Sent as `reasoning_effort` on the outbound request (omitted when "none") —
 * the OpenAI-compatible knob most reasoning models now accept. */
const THINK_LEVELS = [
  { value: "none", label: "Think: None" },
  { value: "low", label: "Think: Low" },
  { value: "medium", label: "Think: Medium" },
  { value: "high", label: "Think: High" },
  { value: "xhigh", label: "Think: X-High" },
  { value: "max", label: "Think: Max" },
];

function estimateContextTokens(messages: StudioMessage[]): number {
  return Math.ceil(messages.reduce((total, message) => total + message.content.length + (message.images?.length ?? 0) * 1_000, 0) / 4);
}

function ContextIndicator({ messages }: { messages: StudioMessage[] }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutsideClose(open, close);
  const tokens = estimateContextTokens(messages);
  const label = tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-label="Chat context information" aria-expanded={open} className="group grid h-8 w-8 place-items-center rounded-full bg-[var(--hover)] transition-colors hover:bg-[var(--active-pill)]" title={`About ${tokens.toLocaleString()} tokens in this chat`}>
        <span className="grid h-5 w-5 place-items-center rounded-full border-2 border-[var(--inner-border)] border-t-[var(--accent)] transition-transform group-hover:rotate-45"><span className="h-1 w-1 rounded-full bg-[var(--accent)]" /></span>
      </button>
      {open && <div className="absolute bottom-[calc(100%+8px)] right-0 z-50 w-52 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)] p-3 shadow-2xl backdrop-blur-xl"><div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full border-2 border-[var(--inner-border)] border-t-[var(--accent)]"><Info size={12} className="text-[var(--accent)]" /></span><div><p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-3)]">Current context</p><p className="text-sm font-bold">≈ {label} tokens</p></div></div><p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-3)]">Estimated from this chat's messages and images.</p></div>}
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

interface StudioSessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface StudioSession {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  messages: StudioMessage[];
  createdAt: string;
  updatedAt: string;
}

const ACTIVE_SESSION_KEY = "cartethyia:model-studio:active-session";
const AUTOSAVE_DELAY_MS = 600;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Closes a floating panel on outside pointerdown or Escape — shared by
 * every dropdown/popover on this page so they behave identically. */
function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);
  return ref;
}

// Centered on the viewport (not anchored to the trigger's edge) so it can
// never overflow off-screen regardless of where the trigger sits in a
// wrapped toolbar — the failure mode with edge-anchored positioning on
// narrow screens.
const panelClass = "glass-2 fixed left-1/2 top-1/2 z-50 max-h-[75vh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-[var(--inner-border)] shadow-2xl";

/** Compact macOS-style model picker: click opens a floating searchable list
 * directly (no accordion step), grouped by provider with a live dot showing
 * whether that provider has a saved account to auto-credential through. */
function ModelDropdown({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutsideClose(open, close);
  const inputRef = useRef<HTMLInputElement>(null);

  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const catalog = useModelCatalog(providers, open);
  const customProvidersQuery = useCustomProviders(open);
  const customCatalog = useCustomProviderCatalog(customProvidersQuery.data?.items ?? []);
  const aliasesQuery = useAliases(open);
  const combosQuery = useCombos(open);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const q = search.trim().toLowerCase();
  const combos = (combosQuery.data?.items ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
  const aliases = (aliasesQuery.data?.items ?? []).filter((alias) => !q || alias.alias.toLowerCase().includes(q));
  const grouped = useMemo(() => {
    const map = new Map<string, { provider: ProviderSummary; models: FlatModelEntry[] }>();
    for (const entry of [...catalog, ...customCatalog]) {
      if (q && !entry.qualified.toLowerCase().includes(q)) continue;
      const group = map.get(entry.provider.id);
      if (group) group.models.push(entry);
      else map.set(entry.provider.id, { provider: entry.provider, models: [entry] });
    }
    return [...map.values()];
  }, [catalog, customCatalog, q]);

  const selectedProvider = providers.find((p) => value.startsWith(`${p.prefix}/`));
  const pick = (qualified: string) => {
    onChange(qualified);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9.5 max-w-full min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 text-left text-[12.5px] transition-colors hover:border-[var(--accent)]"
      >
        {selectedProvider ? (
          <ProviderIcon icon={selectedProvider.icon} name={selectedProvider.name} size={20} />
        ) : (
          <Boxes size={16} className="shrink-0 text-[var(--text-3)]" />
        )}
        <span className={cn("min-w-0 max-w-[45vw] truncate font-mono sm:max-w-[200px]", !value && "font-sans text-[var(--text-3)]")}>{value || "Select a model…"}</span>
        {selectedProvider && (
          <span
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", selectedProvider.connections > 0 ? "bg-[var(--green)]" : "bg-[var(--red)]")}
            title={selectedProvider.connections > 0 ? "Has a saved account — credential auto-resolves" : "No active account for this provider"}
          />
        )}
        <ChevronDown size={13} className="shrink-0 text-[var(--text-3)]" />
      </button>

      {open && (
        <div className={cn(panelClass, "w-[min(320px,calc(100vw-2rem))]")}>
          <div className="border-b border-[var(--inner-border)] p-2">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
              <input
                ref={inputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models or combos…"
                className="w-full rounded-lg border-none bg-[var(--surface)] py-1.5 pl-8 pr-2.5 text-[12.5px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
              />
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {aliases.length > 0 && (
              <div className="mb-1">
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]">Aliases</div>
                {aliases.map((alias) => (
                  <button key={alias.alias} type="button" onClick={() => pick(alias.alias)} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--hover)]", value === alias.alias && "bg-[var(--accent-soft)] text-[var(--accent)]")}>
                    <span className="min-w-0 flex-1 truncate font-mono">{alias.alias}</span>{value === alias.alias && <Check size={13} className="shrink-0" />}
                  </button>
                ))}
              </div>
            )}
            {combos.length > 0 && (
              <div className="mb-1">
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]">Combos</div>
                {combos.map((combo) => (
                  <button
                    key={combo.name}
                    type="button"
                    onClick={() => pick(combo.name)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--hover)]",
                      value === combo.name && "bg-[var(--accent-soft)] text-[var(--accent)]"
                    )}
                  >
                    <Boxes size={14} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono">{combo.name}</span>
                    {value === combo.name && <Check size={13} className="shrink-0" />}
                  </button>
                ))}
              </div>
            )}
            {grouped.length === 0 && combos.length === 0 && aliases.length === 0 ? (
              <div className="py-8 text-center text-[11px] text-[var(--text-3)]">No models match.</div>
            ) : (
              grouped.map(({ provider, models }) => (
                <div key={provider.id} className="mb-1">
                  <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-3)]">
                    <span className={cn("h-1.5 w-1.5 rounded-full", provider.connections > 0 ? "bg-[var(--green)]" : "bg-[var(--text-3)]")} />
                    {provider.name}
                  </div>
                  {models.map((entry) => (
                    <button
                      key={entry.qualified}
                      type="button"
                      onClick={() => pick(entry.qualified)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--hover)]",
                        value === entry.qualified && "bg-[var(--accent-soft)] text-[var(--accent)]"
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{entry.qualified.split("/").slice(1).join("/")}</span>
                      {value === entry.qualified && <Check size={13} className="shrink-0" />}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** System prompt + max tokens, tucked behind one icon button instead of an
 * always-expanded panel eating vertical space. */
function PromptPopover({
  maxTokens,
  onMaxTokens,
  reasoningEffort,
  onReasoningEffort,
  compact = false,
}: {
  maxTokens: number;
  onMaxTokens: (value: number) => void;
  reasoningEffort: string;
  onReasoningEffort: (value: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutsideClose(open, close);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9.5 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 text-[12.5px] font-medium text-[var(--text-2)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-1)]",
          reasoningEffort !== "none" && "border-[var(--accent)] text-[var(--accent)]"
        )}
        title="Thinking and max tokens"
      >
        <MessageSquareText size={15} className="shrink-0" />
        <span className={cn("whitespace-nowrap", compact && "hidden sm:inline")}>{reasoningEffort !== "none" ? "Options set" : "Options"}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 space-y-3 rounded-2xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)] p-3 shadow-2xl backdrop-blur-xl">
          <div className="max-w-[180px]">
            <label className="mb-1.5 block text-[11px] font-semibold text-[var(--text-2)]">Thinking</label>
            <Select ariaLabel="Reasoning effort" value={reasoningEffort} onChange={onReasoningEffort} options={THINK_LEVELS} />
          </div>
          <div className="max-w-[140px]">
            <label className="mb-1.5 block text-[11px] font-semibold text-[var(--text-2)]">Max tokens</label>
            <Input
              type="number"
              min={1}
              max={65536}
              value={String(maxTokens)}
              onChange={(e) => onMaxTokens(Math.min(65536, Math.max(1, Math.floor(Number(e.target.value) || 4096))))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Reads the console's SSE proxy for /model-studio/chat — same OpenAI Chat
 * Completions chunk shape real clients consume (`delta.content` /
 * `delta.reasoning_content`, terminated by `data: [DONE]`). */
async function streamModelStudioChat(
  payload: { model: string; messages: { role: string; content: string | ChatContentPart[] }[]; maxTokens: number; reasoningEffort?: string },
  delta: { onText: (chunk: string) => void; onReasoning: (chunk: string) => void },
  signal: AbortSignal
): Promise<void> {
  const res = await fetch("/console/api/model-studio/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `request failed (${res.status})`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody.error?.message) message = errBody.error.message;
    } catch {
      // non-JSON error body — keep the generic status message
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choiceDelta = parsed.choices?.[0]?.delta;
      if (choiceDelta?.content) delta.onText(choiceDelta.content);
      if (choiceDelta?.reasoning_content) delta.onReasoning(choiceDelta.reasoning_content);
    }
  }
}

/** Flattens a react-markdown code node's children back to plain text for the copy button — they're always strings/arrays of strings for unhighlighted code, but walk element children too in case a remark plugin wraps them. */
function textFromNode(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

/** Fenced code block: language label + copy button, matching the rest of the
 * console's compact icon-button convention. `pre` is stripped to a
 * passthrough below so this owns the box instead of double-nesting `<pre>`. */
function CodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textFromNode(children).replace(/\n$/, "");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--surface)]">
      <div className="flex items-center justify-between border-b border-[var(--inner-border)] px-2.5 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{language || "text"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5">
        <code className="font-mono text-[12px] leading-relaxed">{children}</code>
      </pre>
    </div>
  );
}

// Structural markdown only — react-markdown renders straight to React
// elements (no dangerouslySetInnerHTML), and no raw-HTML plugin is wired in,
// so nothing here can smuggle a script tag through a model's response.
const markdownComponents: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline underline-offset-2">
      {children}
    </a>
  ),
  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-inherit">{children}</strong>,
  em: ({ children }) => <em className="italic text-inherit">{children}</em>,
  del: ({ children }) => <del className="text-[var(--text-3)]">{children}</del>,
  h1: ({ children }) => <h1 className="mb-1.5 mt-2 text-[15px] font-bold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-2 text-[14px] font-bold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-[13.5px] font-bold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-1.5 text-[13px] font-bold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 mt-1.5 text-[13px] font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 mt-1.5 text-[13px] font-semibold text-[var(--text-2)] first:mt-0">{children}</h6>,
  hr: () => <hr className="my-2 border-[var(--inner-border)]" />,
  li: ({ children }) => <li className="[&>p]:mb-0">{children}</li>,
  ul: ({ children }) => <ul className="mb-1.5 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-1.5 list-decimal space-y-0.5 pl-4 last:mb-0">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 border-[var(--inner-border)] pl-2.5 text-[var(--text-2)]">{children}</blockquote>,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto rounded-lg border border-[var(--inner-border)]">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[var(--hover)]">{children}</thead>,
  th: ({ children }) => <th className="border-b border-[var(--inner-border)] px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-[var(--inner-border)] px-2 py-1 align-top last:border-b-0">{children}</td>,
  // Fenced blocks route through CodeBlock (with the copy button); `pre` just
  // unwraps since CodeBlock already renders its own `<pre>`.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const language = /language-(\w+)/.exec(className ?? "")?.[1];
    if (!language) {
      return (
        <code className="rounded bg-[var(--surface)] px-1 py-0.5 font-mono text-[12px]" {...props}>
          {children}
        </code>
      );
    }
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
};

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 text-[13px] leading-relaxed text-[var(--text-1)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function ModelStudioPage() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(ACTIVE_SESSION_KEY));
  const [editingTitle, setEditingTitle] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [messageActionIndex, setMessageActionIndex] = useState<number | null>(null);
  const messageHoldTimer = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionsQuery = useQuery({
    queryKey: ["model-studio", "sessions"],
    queryFn: () => apiGet<{ items: StudioSessionSummary[] }>("/model-studio/sessions"),
  });
  const sessions = sessionsQuery.data?.items ?? [];

  const createSession = useMutation({
    mutationFn: (title: string) => apiPost<StudioSession>("/model-studio/sessions", { title }),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: ["model-studio", "sessions"] });
      setActiveId(session.id);
    },
    onError: () => toast.error("Failed to create session"),
  });

  // Lands straight in a usable chat: auto-create the first session instead
  // of gating behind an empty-state click, and otherwise keep activeId
  // pointed at a real session (falls back to the most recent one).
  const autoCreateStarted = useRef(false);
  useEffect(() => {
    if (sessionsQuery.isLoading) return;
    if (activeId && sessions.some((s) => s.id === activeId)) return;
    if (sessions.length > 0) {
      setActiveId(sessions[0]!.id);
      return;
    }
    if (autoCreateStarted.current) return;
    autoCreateStarted.current = true;
    createSession.mutate("New chat");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsQuery.isLoading, sessions.map((s) => s.id).join(",")]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_SESSION_KEY, activeId);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  }, [activeId]);

  const sessionQuery = useQuery({
    queryKey: ["model-studio", "session", activeId],
    queryFn: () => apiGet<StudioSession>(`/model-studio/sessions/${activeId}`),
    enabled: activeId !== null,
  });

  // Local editable draft, synced from the server only when switching to a
  // different session — never clobbered by a background refetch mid-edit or
  // mid-stream (same pattern as Settings' system-prompt draft).
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState(4096);
  const [reasoningEffort, setReasoningEffort] = useState("none");
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  const syncedIdRef = useRef<string | null>(null);
  const skipSaveRef = useRef(true);
  if (sessionQuery.data && syncedIdRef.current !== sessionQuery.data.id) {
    syncedIdRef.current = sessionQuery.data.id;
    skipSaveRef.current = true;
    setTitle(sessionQuery.data.title);
    setModel(sessionQuery.data.model);
    setSystemPrompt(sessionQuery.data.systemPrompt);
    setMessages(sessionQuery.data.messages);
  }

  // Debounced autosave whenever the draft changes, skipping the sync above.
  useEffect(() => {
    if (!activeId || activeId !== syncedIdRef.current) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      // reasoning is client-only display state — never persisted; images are.
      const persisted = messages.map(({ role, content, ts, images }) => ({ role, content, ts, images }));
      void apiPatch(`/model-studio/sessions/${activeId}`, { title, model, systemPrompt, messages: persisted })
        .then(() => void queryClient.invalidateQueries({ queryKey: ["model-studio", "sessions"] }))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 404) {
            // Deleted from another tab/session — drop back to session selection
            // instead of retrying against a dead id forever.
            syncedIdRef.current = null;
            setActiveId(null);
            void queryClient.invalidateQueries({ queryKey: ["model-studio", "sessions"] });
            return;
          }
          toast.error("Failed to save session");
        });
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, model, systemPrompt, messages, activeId]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeId, messages.length]);

  const deleteSession = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/model-studio/sessions/${id}`),
    onSuccess: (_res, id) => {
      void queryClient.invalidateQueries({ queryKey: ["model-studio", "sessions"] });
      if (activeId === id) setActiveId(null);
      setDeleteTarget(null);
      toast.success("Session deleted");
    },
    onError: () => toast.error("Failed to delete session"),
  });

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      toast.error(`Up to ${MAX_ATTACHMENTS} images per message`);
      return;
    }
    const oversized = images.some((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (oversized) toast.error("Skipped an image over 8MB");
    const accepted = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES).slice(0, room);
    const read = await Promise.all(
      accepted.map(async (file) => ({ id: crypto.randomUUID(), name: file.name || "pasted-image", dataUrl: await fileToDataUrl(file) }))
    );
    setAttachments((prev) => [...prev, ...read]);
  };

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));
  // Which assistant messages have their "Thinking" panel expanded — the
  // currently-streaming message is always shown open regardless of this set,
  // then auto-collapses (falls back to this default-empty set) once it
  // finishes, matching a ChatGPT-style reasoning trace.
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  const toggleThinking = (index: number) =>
    setExpandedThinking((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || !model.trim() || sending) return;
    setDraft("");
    const images = attachments.map((a) => a.dataUrl);
    setAttachments([]);
    const userMessage: StudioMessage = { role: "user", content: text, ts: new Date().toISOString(), ...(images.length > 0 ? { images } : {}) };
    const history = [...messages, userMessage];
    const assistantIndex = history.length;
    setMessages([...history, { role: "assistant", content: "", ts: new Date().toISOString() }]);
    setSending(true);

    // Multimodal shape (OpenAI content-parts array) only when a turn actually
    // carries images — every other message stays a plain string, matching
    // what a real text-only client would send.
    const toWireContent = (msg: StudioMessage): string | ChatContentPart[] => {
      if (!msg.images || msg.images.length === 0) return msg.content;
      const parts: ChatContentPart[] = [];
      if (msg.content) parts.push({ type: "text", text: msg.content });
      for (const url of msg.images) parts.push({ type: "image_url", image_url: { url } });
      return parts;
    };
    const payloadMessages = [
      ...history.map((msg) => ({ role: msg.role, content: toWireContent(msg) })),
    ];

    const controller = new AbortController();
    abortRef.current = controller;
    let textAcc = "";
    let reasoningAcc = "";
    const patchLast = (patch: Partial<StudioMessage>) =>
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = { ...last, ...patch };
        return next;
      });

    try {
      await streamModelStudioChat(
        { model: model.trim(), messages: payloadMessages, maxTokens, reasoningEffort: reasoningEffort === "none" ? undefined : reasoningEffort },
        {
          onText: (chunk) => {
            textAcc += chunk;
            patchLast({ content: textAcc });
          },
          onReasoning: (chunk) => {
            reasoningAcc += chunk;
            patchLast({ reasoning: reasoningAcc });
          },
        },
        controller.signal
      );
      // Reasoning-only response (no visible answer) — keep the thinking
      // trace expanded so the turn isn't a blank bubble.
      if (!textAcc && reasoningAcc) {
        patchLast({ content: "_(model produced no visible output — see \"Thinking\" below)_" });
        setExpandedThinking((prev) => new Set(prev).add(assistantIndex));
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      const message = err instanceof Error ? err.message : "Request failed";
      if (!textAcc && !isAbort) patchLast({ content: `⚠ ${message}` });
      if (!isAbort) toast.error(message);
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const activeSummary = sessions.find((s) => s.id === activeId);

  return (
    <Card className="flex h-[calc(100dvh-102px)] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100dvh-118px)]">
      {/* Session bar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--inner-border)] p-2 sm:gap-2 sm:p-3">
        <Select
          ariaLabel="Session"
          value={activeId ?? ""}
          onChange={(value) => setActiveId(value || null)}
          options={sessions.map((s) => ({ value: s.id, label: `${s.title} · ${timeAgo(s.updatedAt)}` }))}
          className="max-w-[190px] sm:max-w-[220px]"
        />
        <div className="hidden sm:block">{editingTitle ? (
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditingTitle(false)}
            className="h-8 max-w-[200px]"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditingTitle(true)}
            className="flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold text-[var(--text-2)] transition-colors hover:text-[var(--accent)]"
            title="Rename session"
          >
            <Pencil size={11} className="shrink-0" /> <span className="truncate">{title || "Untitled"}</span>
          </button>
        )}</div>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <button type="button" onClick={() => setEditingTitle(true)} aria-label="Rename session" title="Rename session" className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] sm:hidden">
            <Pencil size={13} />
          </button>
          <PromptPopover maxTokens={maxTokens} onMaxTokens={setMaxTokens} reasoningEffort={reasoningEffort} onReasoningEffort={setReasoningEffort} compact />
          <Button variant="secondary" size="sm" onClick={() => createSession.mutate("New chat")} disabled={createSession.isPending} aria-label="New chat">
            <Plus size={13} /><span className="hidden sm:inline">New</span>
          </Button>
          <Button variant="secondary" size="sm" className="text-[var(--red)]" onClick={() => activeId && setDeleteTarget(activeId)} disabled={!activeId}>
            <Trash2 size={13} />
          </Button>
        </div>
      </div>
      {editingTitle && (
        <div className="border-b border-[var(--inner-border)] px-2 py-1.5 sm:hidden">
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditingTitle(false)} onKeyDown={(e) => e.key === "Enter" && setEditingTitle(false)} className="h-8 text-xs" />
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 sm:space-y-3 sm:px-4 sm:py-3">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 text-center text-[var(--text-3)] sm:min-h-[240px]">
            <Bot size={26} />
            <p className="text-xs">Pick a model below and send a message to start testing.</p>
          </div>
        ) : (
          messages.map((m, i) => {
            const isStreamingThis = sending && i === messages.length - 1;
            const thinkingOpen = expandedThinking.has(i) || isStreamingThis;
            const hasAnyOutput = Boolean(m.content) || Boolean(m.reasoning);
            return (
              <div key={i} onContextMenu={(event) => { event.preventDefault(); setMessageActionIndex(i); }} onPointerDown={() => { messageHoldTimer.current = window.setTimeout(() => setMessageActionIndex(i), 500); }} onPointerUp={() => { clearTimeout(messageHoldTimer.current); messageHoldTimer.current = undefined; }} onPointerCancel={() => { clearTimeout(messageHoldTimer.current); messageHoldTimer.current = undefined; }} className={cn("relative flex gap-2.5", m.role === "user" && "flex-row-reverse")}>
                <span
                  className={cn(
                    "grid h-7 w-7 shrink-0 place-items-center rounded-full",
                    m.role === "user" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--hover)] text-[var(--text-2)]"
                  )}
                >
                  {m.role === "user" ? <User size={14} /> : <Bot size={14} />}
                </span>
                <div className="min-w-0 max-w-[80%] space-y-1.5">
                  {messageActionIndex === i && (
                    <div className={cn("absolute top-0 z-20 rounded-lg border border-[var(--inner-border)] bg-[var(--glass-bg-2)] p-1 shadow-xl", m.role === "user" ? "right-10" : "left-10")}>
                      <button type="button" onClick={() => { setMessages((current) => current.filter((_, index) => index !== i)); setMessageActionIndex(null); }} className="rounded-md px-2 py-1 text-[11px] font-semibold text-[var(--red)] hover:bg-[var(--hover)]">Delete message</button>
                    </div>
                  )}
                  {m.role === "assistant" && m.reasoning && (
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => toggleThinking(i)}
                        className="flex items-center gap-1 rounded-full border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--text-3)] transition-colors hover:text-[var(--text-2)]"
                      >
                        <Brain size={10} className={cn(isStreamingThis && !m.content && "animate-pulse")} />
                        {isStreamingThis && !m.content ? "Thinking…" : "Thinking"}
                        <ChevronDown size={9} className={cn("transition-transform", thinkingOpen && "rotate-180")} />
                      </button>
                      {thinkingOpen && (
                        <div className="mt-1 whitespace-pre-wrap rounded-xl border border-dashed border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[11.5px] italic leading-relaxed text-[var(--text-3)]">
                          {m.reasoning}
                        </div>
                      )}
                    </div>
                  )}
                  {(m.content || (m.images && m.images.length > 0) || (isStreamingThis && !hasAnyOutput)) && (
                    <div
                      className={cn(
                        "glass-2 whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5",
                        m.role === "user" && "whitespace-pre-wrap bg-[var(--accent)] text-[13px] leading-relaxed text-white"
                      )}
                    >
                      {m.images && m.images.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-1.5 last:mb-0">
                          {m.images.map((url, imgIndex) => (
                            <a key={imgIndex} href={url} target="_blank" rel="noreferrer">
                              <img src={url} alt="" className="h-24 w-24 rounded-lg border border-white/20 object-cover" />
                            </a>
                          ))}
                        </div>
                      )}
                      {m.role === "assistant" ? (
                        m.content ? <AssistantMarkdown content={m.content} /> : <Loader2 size={14} className="animate-spin text-[var(--text-3)]" />
                      ) : (
                        m.content
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Claude-style composer: the prompt is primary; model and request controls stay in its footer. */}
      <div className="shrink-0 border-t border-[var(--inner-border)] p-1.5 sm:p-2">
        <div className="rounded-2xl border border-[var(--inner-border)] bg-[var(--hover)] p-2 shadow-[0_3px_12px_rgba(0,0,0,0.08)] transition-colors focus-within:border-[var(--accent)] focus-within:bg-[var(--glass-bg-2)]">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1">
              {attachments.map((a) => (
                <div key={a.id} className="group relative h-14 w-14 shrink-0">
                  <img src={a.dataUrl} alt={a.name} className="h-full w-full rounded-lg border border-[var(--inner-border)] object-cover" />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`Remove ${a.name}`}
                    className="absolute -right-1.5 -top-1.5 grid h-4.5 w-4.5 place-items-center rounded-full bg-[var(--red)] text-white shadow transition-transform group-hover:scale-110"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.items)
                .filter((item) => item.type.startsWith("image/"))
                .map((item) => item.getAsFile())
                .filter((f): f is File => f !== null);
              if (files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            placeholder="Message the model…"
            data-model-studio-composer
            rows={1}
            className="min-h-[40px] max-h-24 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-[13px] shadow-none focus:bg-transparent focus-visible:outline-0"
          />
          <div className="flex flex-wrap items-center gap-1 border-t border-[var(--inner-border)] pt-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <ModelDropdown value={model} onChange={setModel} />
            <ContextIndicator messages={messages} />
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="secondary"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach image"
                title="Attach image (or paste with Ctrl+V)"
              >
                <ImagePlus size={15} />
              </Button>
              {sending ? (
                <Button variant="secondary" size="icon" onClick={() => abortRef.current?.abort()} aria-label="Stop">
                  <Square size={15} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={() => void send()}
                  disabled={(!draft.trim() && attachments.length === 0) || !model.trim()}
                  aria-label="Send"
                >
                  <Send size={15} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteSession.mutate(deleteTarget)}
        title="Delete session?"
        message={`Delete "${activeSummary?.title ?? "this session"}" and its full message history? This can't be undone.`}
        danger
        confirmLabel="Delete"
      />
    </Card>
  );
}
