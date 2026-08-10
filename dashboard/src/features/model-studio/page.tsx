/**
 * Model Studio — compact chat playground. iOS-style bubble animations,
 * TTFB + completion timing, per-message copy, ChatGPT-style reasoning dropdown.
 * Every send goes through the real dispatchQualifiedRoute pipeline.
 */

import { isValidElement, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Brain, Check, ChevronDown, Clock, Copy, ImagePlus,
  Loader2, MessageSquareText, MoreHorizontal, Pencil, Paperclip, Plus,
  RotateCcw, Send, Square, Timer, Trash2, User, X, Zap,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "../../lib/toast";
import { ApiError, apiGet, apiPatch, apiPost, apiDelete } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { cn } from "../../lib/cn";
import { qk } from "../../lib/query-keys";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input, Textarea } from "../../components/ui/input";
import { Select } from "../../components/ui/tabs";
import { Switch } from "../../components/ui/switch";
import { ConfirmDialog } from "../../components/shared";
import { ConfiguredModelPicker } from "../../components/model-picker";
// Bundled character prompt — loaded at build time via Vite ?raw import.
import { Popout } from "../../lib/popout";
import { formatStudioDuration as formatMs, formatStudioTokenCount as formatTokenCount } from "./formatters";
import { streamModelStudioChat, studioUsageFromChatUsage, type ChatContentPart, type ChatUsagePayload, type StudioUsage } from "./stream";
import jinhsiPromptText from "./jinhsi-prompt.txt?raw";

// ── Types ──────────────────────────────────────────────────────────────────


interface StudioMessage {
  role: "system" | "user" | "assistant";
  content: string;
  ts: string;
  reasoning?: string;
  usage?: StudioUsage;
  images?: string[];
  /** Time to first token in ms — when the first text/reasoning chunk arrived. */
  ttfbMs?: number;
  /** Total completion time in ms — from send to stream end. */
  completionMs?: number;
}


interface PendingAttachment { id: string; dataUrl: string; name: string }

interface StudioSessionSummary { id: string; title: string; model: string; messageCount: number; createdAt: string; updatedAt: string }
interface StudioSession { id: string; title: string; model: string; systemPrompt: string; messages: StudioMessage[]; createdAt: string; updatedAt: string }

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ACTIVE_SESSION_KEY = "cartethyia:model-studio:active-session";
const AUTOSAVE_DELAY_MS = 600;

const THINK_LEVELS = [
  { value: "auto", label: "Think: Auto" }, { value: "none", label: "Think: None" },
  { value: "low", label: "Think: Low" }, { value: "medium", label: "Think: Medium" },
  { value: "high", label: "Think: High" }, { value: "xhigh", label: "Think: X-High" },
  { value: "max", label: "Think: Max" },
];
const OPENAI_REASONING_SUMMARIES = [
  { value: "concise", label: "Summary: Concise" },
  { value: "detailed", label: "Summary: Detailed" },
];
const ANTHROPIC_THINK_LEVELS = [
  { value: "auto", label: "Think: Auto" }, { value: "none", label: "Think: None" },
  { value: "low", label: "Think: Low (1K)" }, { value: "medium", label: "Think: Medium (4K)" },
  { value: "high", label: "Think: High (8K)" }, { value: "xhigh", label: "Think: X-High (16K)" },
  { value: "max", label: "Think: Max (32K)" },
];
const THINK_TOKEN_PRESETS: Record<string, number> = { auto: 8_192, none: 4_096, low: 8_192, medium: 16_384, high: 32_768, xhigh: 49_152, max: 65_536 };
const ANTHROPIC_THINK_TOKEN_PRESETS: Record<string, number> = { auto: 8_192, none: 4_096, low: 1_024, medium: 4_096, high: 8_192, xhigh: 16_384, max: 32_768 };

// ── Helpers ────────────────────────────────────────────────────────────────


function maxTokensForThinking(value: string, isAnthropic = false): number {
  return (isAnthropic ? ANTHROPIC_THINK_TOKEN_PRESETS : THINK_TOKEN_PRESETS)[value] ?? THINK_TOKEN_PRESETS.auto;
}
function getThinkLevels(isAnthropic = false) { return isAnthropic ? ANTHROPIC_THINK_LEVELS : THINK_LEVELS; }
function estimateTextTokens(value: string): number { return Math.max(0, Math.ceil(Array.from(value).length / 4)); }
function estimateMessageTokens(message: StudioMessage): number { return estimateTextTokens(message.content) + (message.images?.length ?? 0) * 1_000; }


function toWireContent(message: StudioMessage): string | ChatContentPart[] {
  if (!message.images || message.images.length === 0) return message.content;
  const parts: ChatContentPart[] = [];
  if (message.content) parts.push({ type: "text", text: message.content });
  for (const url of message.images) parts.push({ type: "image_url", image_url: { url } });
  return parts;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

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


// ── Markdown ───────────────────────────────────────────────────────────────

function textFromNode(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromNode(node.props.children);
  return "";
}

function CodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);
  const text = textFromNode(children).replace(/\n$/, "");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); if (timerRef.current) window.clearTimeout(timerRef.current); timerRef.current = window.setTimeout(() => { timerRef.current = null; setCopied(false); }, 1500); } catch { toast.error("Copy failed"); }
  };
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)]">
      <div className="flex items-center justify-between border-b border-[var(--inner-border)] px-2.5 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">{language || "text"}</span>
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-3)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--text-1)]">
          {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-2.5"><code className="font-mono text-[12px] leading-relaxed">{children}</code></pre>
    </div>
  );
}

const markdownComponents: Components = {
  a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline underline-offset-2">{children}</a>,
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
  table: ({ children }) => <div className="my-1.5 overflow-x-auto rounded-lg border border-[var(--inner-border)]"><table className="w-full border-collapse text-[12px]">{children}</table></div>,
  thead: ({ children }) => <thead className="bg-[var(--hover)]">{children}</thead>,
  th: ({ children }) => <th className="border-b border-[var(--inner-border)] px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-[var(--inner-border)] px-2 py-1 align-top last:border-b-0">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    const language = /language-(\w+)/.exec(className ?? "")?.[1];
    if (!language) return <code className="rounded bg-[var(--surface-1)] px-1 py-0.5 font-mono text-[12px]" {...props}>{children}</code>;
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
};

function AssistantMarkdown({ content }: { content: string }) {
  return <div className="min-w-0 text-[13px] leading-relaxed text-[var(--text-1)]"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown></div>;
}

// ── Context indicator ──────────────────────────────────────────────────────

interface TokenSnapshot { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number; totalTokens: number; summary: string; source: "provider" | "estimated" }

function getTokenSnapshot(messages: StudioMessage[], systemPrompt: string): TokenSnapshot {
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const latestUsage = [...assistantMessages].reverse().find((m) => m.usage)?.usage;
  const outputTokens = assistantMessages.reduce((t, m) => t + (m.usage?.outputTokens ?? estimateTextTokens(m.content)), 0);
  const reasoningTokens = assistantMessages.reduce((t, m) => t + (m.usage?.reasoningTokens ?? estimateTextTokens(m.reasoning ?? "")), 0);
  const estimatedInput = estimateTextTokens(systemPrompt) + messages.reduce((t, m) => t + estimateMessageTokens(m), 0);
  const inputTokens = latestUsage?.inputTokens ?? estimatedInput;
  const summaryMessage = [...messages].reverse().find((m) => m.role === "system" && m.content.startsWith("[Compacted context]"));
  return { inputTokens, outputTokens, reasoningTokens, cachedTokens: latestUsage?.cachedTokens ?? 0, totalTokens: inputTokens + outputTokens + reasoningTokens, summary: summaryMessage?.content.replace("[Compacted context]", "").trim() || "No compacted summary yet.", source: latestUsage ? "provider" : "estimated" };
}

function ContextIndicator({ messages, systemPrompt, compacting, onCompact }: { messages: StudioMessage[]; systemPrompt: string; compacting: boolean; onCompact: () => void }) {
  const [open, setOpen] = useState(false);
  const snapshot = getTokenSnapshot(messages, systemPrompt);
  const label = formatTokenCount(snapshot.inputTokens);
  const panelClass = "popout-enter bg-[var(--popover-bg)] overflow-hidden overflow-y-auto rounded-2xl border border-[var(--inner-border)] shadow-2xl w-[min(320px,calc(100vw-1rem))] space-y-3 p-3";
  return (
    <Popout
      open={open}
      onClose={() => setOpen(false)}
      width={320}
      preferUp
      panelClassName={panelClass}
      trigger={(ref) => (
        <button ref={ref} type="button" onClick={() => setOpen((c) => !c)} aria-label="Chat token usage" aria-expanded={open} className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-left text-[11px] transition-colors hover:border-[var(--accent)]">
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 border-[var(--inner-border)] border-t-[var(--accent)]"><span className="h-0.5 w-0.5 rounded-full bg-[var(--accent)]" /></span>
          <span className="shrink-0 font-mono font-semibold text-[var(--accent)]">{label}</span>
          <ChevronDown size={11} className={cn("shrink-0 text-[var(--text-3)] transition-transform", open && "rotate-180")} />
        </button>
      )}
      panel={() => (
        <>
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><Zap size={14} /></span>
            <div><p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">Context</p><p className="text-xs font-bold">{snapshot.source === "provider" ? "Provider usage" : "Estimated"}</p></div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
            <span className="rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-1.5">In<strong className="block font-mono">{formatTokenCount(snapshot.inputTokens)}</strong></span>
            <span className="rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-1.5">Out<strong className="block font-mono">{formatTokenCount(snapshot.outputTokens)}</strong></span>
            <span className="rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-1.5">Think<strong className="block font-mono">{formatTokenCount(snapshot.reasoningTokens)}</strong></span>
            <span className="rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-1.5">Cache<strong className="block font-mono">{formatTokenCount(snapshot.cachedTokens)}</strong></span>
          </div>
          <button type="button" onClick={() => { setOpen(false); onCompact(); }} disabled={compacting || messages.length < 2} className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[11px] font-semibold text-[var(--accent)] transition-colors hover:border-[var(--accent)] disabled:opacity-50">
            <MoreHorizontal size={12} /> {compacting ? "Compacting…" : "Compact context"}
          </button>
        </>
      )}
    />
  );
}


// ── Prompt popover ─────────────────────────────────────────────────────────

function PromptPopover({ maxTokens, onMaxTokens, reasoningEffort, onReasoningEffort, reasoningSummary, onReasoningSummary, providerId, systemPromptOverride, onSystemPromptOverride, systemPromptEnabled, onSystemPromptEnabled, bokepEnabled, onBokepEnabled, title, onTitleChange }: { maxTokens: number; onMaxTokens: (v: number) => void; reasoningEffort: string; onReasoningEffort: (v: string) => void; reasoningSummary: string; onReasoningSummary: (v: string) => void; providerId?: string; systemPromptOverride: string; onSystemPromptOverride: (v: string) => void; systemPromptEnabled: boolean; onSystemPromptEnabled: (v: boolean) => void; bokepEnabled: boolean; onBokepEnabled: (v: boolean) => void; title: string; onTitleChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [showBokepPreview, setShowBokepPreview] = useState(false);
  const isAnthropic = providerId === "anthropic";
  const thinkingMaxTokens = maxTokensForThinking(reasoningEffort, isAnthropic);
  const handleReasoningChange = (value: string) => { onReasoningEffort(value); onMaxTokens(maxTokensForThinking(value, isAnthropic)); };
  const activeInjection = systemPromptEnabled || bokepEnabled;
  const panelClass = "popout-enter bg-[var(--popover-bg)] overflow-hidden overflow-y-auto rounded-2xl border border-[var(--inner-border)] shadow-2xl w-[min(360px,calc(100vw-1.5rem))] space-y-3 p-3";
  return (
    <Popout
      open={open}
      onClose={() => setOpen(false)}
      width={360}
      panelClassName={panelClass}
      trigger={(ref) => (
        <button ref={ref} type="button" onClick={() => setOpen((v) => !v)} className={cn("flex h-8 min-w-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-[11px] font-medium text-[var(--text-2)] transition-colors hover:border-[var(--accent)]", reasoningEffort !== "none" && reasoningEffort !== "auto" && "border-[var(--accent)] text-[var(--accent)]", activeInjection && "border-[var(--accent)] text-[var(--accent)]")} title="Options" aria-expanded={open}>
          <MessageSquareText size={13} className="shrink-0" />
          <span className="whitespace-nowrap">Options</span>
          <ChevronDown size={11} className={cn("shrink-0 text-[var(--text-3)] transition-transform", open && "rotate-180")} />
        </button>
      )}
      panel={() => (
        <>
          {/* Session title — editable inline */}
          <div className="border-b border-[var(--inner-border)] pb-2">
            <label className="text-[11px] font-semibold text-[var(--text-2)]">Session title</label>
            <input
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Untitled"
              className="mt-1 w-full rounded-lg border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[11.5px] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="border-t border-[var(--inner-border)] pt-2">
            {!isAnthropic && <p className="mb-2 text-[11px] font-semibold text-[var(--text-2)]">OpenAI advanced settings</p>}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(140px,200px)]">
              <label className="min-w-0 text-[11px] font-semibold text-[var(--text-2)]">Thinking level<Select ariaLabel="Reasoning effort" value={reasoningEffort} onChange={handleReasoningChange} options={getThinkLevels(isAnthropic)} /></label>
              {!isAnthropic && <label className="min-w-0 text-[11px] font-semibold text-[var(--text-2)]">Reasoning summary<Select ariaLabel="Reasoning summary" value={reasoningSummary} onChange={onReasoningSummary} options={OPENAI_REASONING_SUMMARIES} /></label>}
              <label className="min-w-0 text-[11px] font-semibold text-[var(--text-2)]">Max tokens<Input name="ms-max-tokens" type="number" inputMode="numeric" min={1} max={thinkingMaxTokens} value={String(Math.min(maxTokens, thinkingMaxTokens))} onChange={(e) => onMaxTokens(Math.min(thinkingMaxTokens, Math.max(1, Math.floor(Number(e.target.value) || 4096))))} /></label>
            </div>
          </div>
          {/* System prompt injection — custom override (user's own text) */}
          <div className="border-t border-[var(--inner-border)] pt-2">
            <div className="flex items-center justify-between gap-2">
              <label className={cn("text-[11px] font-semibold", bokepEnabled ? "text-[var(--text-3)]" : "text-[var(--text-2)]")}>System Prompt Override</label>
              <Switch checked={systemPromptEnabled} onChange={onSystemPromptEnabled} disabled={bokepEnabled} label="Override" />
            </div>
            <p className="mt-0.5 text-[10px] text-[var(--text-3)]">When enabled, this system prompt is prepended to every request.</p>
            {systemPromptEnabled && (
              <textarea
                value={systemPromptOverride}
                onChange={(e) => onSystemPromptOverride(e.target.value)}
                placeholder="Enter system prompt to inject…"
                rows={4}
                className="mt-2 w-full resize-y rounded-lg border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[11.5px] leading-relaxed outline-none focus:border-[var(--accent)]"
              />
            )}
          </div>
          {/* System Prompt Bokep — bundled character prompt (Jinhsi) */}
          <div className="border-t border-[var(--inner-border)] pt-2">
            <div className="flex items-center justify-between gap-2">
              <label className={cn("text-[11px] font-semibold", systemPromptEnabled ? "text-[var(--text-3)]" : "text-[var(--text-2)]")}>System Prompt Bokep</label>
              <Switch checked={bokepEnabled} onChange={onBokepEnabled} disabled={systemPromptEnabled} label="Bokep" />
            </div>
            <p className="mt-0.5 text-[10px] text-[var(--text-3)]">Load the bundled character prompt ({jinhsiPromptText.length.toLocaleString()} chars). Disabled while Override is active.</p>
            {bokepEnabled && (
              <button type="button" onClick={() => setShowBokepPreview((v) => !v)} className="mt-2 flex items-center gap-1 text-[10px] font-semibold text-[var(--accent)] transition-colors hover:text-[var(--accent)]">
                <ChevronDown size={10} className={cn("transition-transform", showBokepPreview && "rotate-180")} />
                {showBokepPreview ? "Hide preview" : "Show preview"}
              </button>
            )}
            {bokepEnabled && showBokepPreview && (
              <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--inner-border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-[10px] leading-relaxed text-[var(--text-3)]">{jinhsiPromptText}</pre>
            )}
          </div>
        </>
      )}
    />
  );
}

// ── Message row ────────────────────────────────────────────────────────────

interface MessageRowProps {
  message: StudioMessage; index: number; isStreaming: boolean; thinkingOpen: boolean;
  editing: boolean; editDraft: string; onEditDraft: (v: string) => void;
  onEdit: (i: number) => void; onSaveEdit: () => void; onCancelEdit: () => void;
  onCopy: (m: StudioMessage) => void; onDelete: (i: number) => void; onThinkingToggle: (i: number) => void;
  onRetry: (i: number) => void;
}

const MessageRow = memo(function MessageRow({ message: m, index: i, isStreaming: isStreamingThis, thinkingOpen, editing, editDraft, onEditDraft, onEdit, onSaveEdit, onCancelEdit, onCopy, onDelete, onThinkingToggle, onRetry }: MessageRowProps) {
  const isUser = m.role === "user";
  const hasOutput = Boolean(m.content) || Boolean(m.reasoning);
  const isError = m.role === "assistant" && !isStreamingThis && (!hasOutput || m.content.startsWith("⚠"));
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current); }, []);

  const handleCopy = () => {
    onCopy(m);
    setCopied(true);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => { copyTimerRef.current = null; setCopied(false); }, 1500);
  };

  return (
    <div className={cn("chat-bubble-enter flex gap-2 sm:gap-2.5", isUser && "flex-row-reverse")}>
      <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full sm:h-7 sm:w-7", isUser ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--hover)] text-[var(--text-2)]")}>
        {isUser ? <User size={12} /> : <Bot size={12} />}
      </span>
      <div className={cn("min-w-0 max-w-[85%] space-y-1 sm:max-w-[80%]", isUser && "items-end")}>
        {/* Reasoning dropdown */}
        {m.role === "assistant" && (m.reasoning || isStreamingThis) && (
          <div className="min-w-0">
            <button type="button" onClick={() => onThinkingToggle(i)} className="flex items-center gap-1 rounded-full border border-[var(--inner-border)] bg-[var(--hover)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-3)] transition-colors hover:text-[var(--text-2)]">
              <Brain size={9} className={cn(isStreamingThis && !m.content && "animate-pulse")} />
              {isStreamingThis && !m.content ? <span className="thinking-shimmer">Thinking</span> : "Thinking"}
              <ChevronDown size={8} className={cn("transition-transform", thinkingOpen && "rotate-180")} />
            </button>
            {thinkingOpen && m.reasoning && <div className="mt-1 whitespace-pre-wrap rounded-xl border border-dashed border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[11px] italic leading-relaxed text-[var(--text-3)]">{m.reasoning}</div>}
          </div>
        )}
        {/* Bubble */}
        {(m.content || (m.images && m.images.length > 0) || (isStreamingThis && !hasOutput)) && (
          editing ? (
            <div className="space-y-1.5">
              <Textarea value={editDraft} onChange={(e) => onEditDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSaveEdit(); } }} rows={3} autoFocus className="min-h-[76px] text-[13px]" />
              <div className="flex items-center justify-end gap-1">
                <button type="button" onClick={onCancelEdit} className="rounded-md p-1.5 text-[var(--text-3)] hover:bg-[var(--hover)]" aria-label="Cancel"><X size={12} /></button>
                <button type="button" onClick={onSaveEdit} className="rounded-md bg-[var(--accent)] p-1.5 text-white" aria-label="Save"><Check size={12} /></button>
              </div>
            </div>
          ) : (
            <div className={cn("whitespace-pre-wrap break-words rounded-2xl px-3 py-2 sm:px-3.5 sm:py-2.5", isUser ? "bg-[var(--accent)] text-[13px] leading-relaxed text-white" : "glass-2")}>
              {m.images && m.images.length > 0 && <div className="mb-1.5 flex flex-wrap gap-1.5 last:mb-0">{m.images.map((url, idx) => <a key={idx} href={url} target="_blank" rel="noreferrer"><img src={url} alt="" className="h-20 w-20 rounded-lg border border-white/20 object-cover sm:h-24 sm:w-24" /></a>)}</div>}
              {m.role === "assistant" ? m.content ? <AssistantMarkdown content={m.content} /> : <span className="thinking-shimmer">Thinking</span> : m.content}
            </div>
          )
        )}
        {/* Meta row: timing + tokens + actions */}
        {/* Error/empty state — show retry button for failed assistant messages */}
        {isError && (
          <div className="flex items-center gap-2">
            <div className="rounded-xl border border-[var(--red)]/30 bg-[var(--red)]/10 px-3 py-2 text-[11px] text-[var(--red)]">
              {m.content || "No response received."}
            </div>
            <button type="button" onClick={() => onRetry(i)} disabled={isStreamingThis} className="inline-flex items-center gap-1 rounded-lg border border-[var(--red)]/40 bg-[var(--red)]/10 px-2.5 py-1.5 text-[11px] font-semibold text-[var(--red)] transition-colors hover:bg-[var(--red)]/20 disabled:opacity-50">
              <RotateCcw size={11} /> Retry
            </button>
          </div>
        )}
        {!editing && hasOutput && (
          <div className={cn("flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-3)]", isUser ? "justify-end" : "justify-start")}>
            {/* TTFB + completion for assistant */}
            {m.role === "assistant" && (m.ttfbMs !== undefined || m.completionMs !== undefined) && (
              <span className="inline-flex items-center gap-1 rounded-md bg-[var(--hover)] px-1.5 py-0.5 font-mono tabular-nums">
                {m.ttfbMs !== undefined && <><Timer size={9} /> {formatMs(m.ttfbMs)}</>}
                {m.ttfbMs !== undefined && m.completionMs !== undefined && " · "}
                {m.completionMs !== undefined && <><Clock size={9} /> {formatMs(m.completionMs)}</>}
              </span>
            )}
            {/* Token count */}
            {m.role === "assistant"
              ? <span className="font-mono">{m.usage?.outputTokens ?? estimateTextTokens(m.content)} out{m.usage?.reasoningTokens ? ` · ${m.usage.reasoningTokens} think` : ""}</span>
              : <span className="font-mono">~{estimateMessageTokens(m)} in</span>
            }
            {/* Actions */}
            <button type="button" onClick={handleCopy} className="inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 hover:bg-[var(--hover)] hover:text-[var(--text-2)]" aria-label="Copy">
              {copied ? <Check size={10} className="text-[var(--green)]" /> : <Copy size={10} />}
            </button>
            <button type="button" onClick={() => onEdit(i)} className="inline-flex items-center rounded-md px-1 py-0.5 hover:bg-[var(--hover)] hover:text-[var(--text-2)]" aria-label="Edit"><Pencil size={10} /></button>
            <button type="button" onClick={() => onDelete(i)} className="inline-flex items-center rounded-md px-1 py-0.5 text-[var(--red)] hover:bg-[var(--hover)]" aria-label="Delete"><Trash2 size={10} /></button>
          </div>
        )}
      </div>
    </div>
  );
});

// ── Session picker ──────────────────────────────────────────────────────────

function SessionPicker({ sessions, activeId, onSelect, onCreate, creating }: { sessions: StudioSessionSummary[]; activeId: string | null; onSelect: (id: string | null) => void; onCreate: () => void; creating: boolean }) {
  const [open, setOpen] = useState(false);
  const active = sessions.find((s) => s.id === activeId);
  const panelClass = "popout-enter bg-[var(--popover-bg)] overflow-hidden overflow-y-auto rounded-2xl border border-[var(--inner-border)] shadow-2xl w-[min(280px,calc(100vw-1rem))] p-1.5";
  return (
    <Popout
      open={open}
      onClose={() => setOpen(false)}
      width={280}
      panelClassName={panelClass}
      trigger={(ref) => (
        <button ref={ref} type="button" onClick={() => setOpen((v) => !v)} aria-label="Sessions" aria-expanded={open} className="flex h-8 min-w-0 max-w-[200px] flex-1 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-left text-[11px] transition-colors hover:border-[var(--accent)] sm:max-w-[240px] sm:text-xs">
          <MessageSquareText size={13} className="shrink-0 text-[var(--text-3)]" />
          <span className={cn("min-w-0 flex-1 truncate", !active && "text-[var(--text-3)]")}>{active ? `${active.title} · ${timeAgo(active.updatedAt)}` : "Select session…"}</span>
          <ChevronDown size={11} className={cn("shrink-0 text-[var(--text-3)] transition-transform", open && "rotate-180")} />
        </button>
      )}
      panel={() => (
        <>
          <button type="button" onClick={() => { setOpen(false); onCreate(); }} disabled={creating} className="mb-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--accent)]/40 px-2 py-1.5 text-left text-[12px] font-semibold text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50">
            {creating ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <Plus size={13} className="shrink-0" />}
            New session
          </button>
          <div className="max-h-64 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="py-4 text-center text-[11px] text-[var(--text-3)]">No sessions yet.</div>
            ) : sessions.map((s) => (
              <button key={s.id} type="button" onClick={() => { onSelect(s.id); setOpen(false); }} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-[var(--hover)]", s.id === activeId && "bg-[var(--accent-soft)] text-[var(--accent)]")}>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-3)]">{timeAgo(s.updatedAt)}</span>
                {s.id === activeId && <Check size={13} className="shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    />
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export function ModelStudioPage() {
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(ACTIVE_SESSION_KEY));
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editingMessageDraft, setEditingMessageDraft] = useState("");
  const [compacting, setCompacting] = useState(false);
  const [autoFollowMessages, setAutoFollowMessages] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionsQuery = useQuery({ queryKey: qk.modelStudio.sessions, queryFn: () => apiGet<{ items: StudioSessionSummary[] }>("/model-studio/sessions") });
  const sessions = sessionsQuery.data?.items ?? [];

  const createSession = useMutation({
    mutationFn: (title: string) => apiPost<StudioSession>("/model-studio/sessions", { title }),
    onSuccess: (session) => { void queryClient.invalidateQueries({ queryKey: qk.modelStudio.sessions }); setActiveId(session.id); },
    onError: () => toast.error("Failed to create session"),
  });

  const autoCreateStarted = useRef(false);
  useEffect(() => {
    if (sessionsQuery.isLoading) return;
    if (activeId && sessions.some((s) => s.id === activeId)) return;
    if (sessions.length > 0) { setActiveId(sessions[0]!.id); return; }
    if (autoCreateStarted.current) return;
    autoCreateStarted.current = true;
    createSession.mutate("New chat");
  }, [sessionsQuery.isLoading, sessions.map((s) => s.id).join(",")]);

  useEffect(() => { if (activeId) localStorage.setItem(ACTIVE_SESSION_KEY, activeId); else localStorage.removeItem(ACTIVE_SESSION_KEY); }, [activeId]);

  const sessionQuery = useQuery({ queryKey: qk.modelStudio.session(activeId), queryFn: () => apiGet<StudioSession>(`/model-studio/sessions/${activeId}`), enabled: activeId !== null });

  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState(4096);
  const [reasoningEffort, setReasoningEffort] = useState("auto");
  const [reasoningSummary, setReasoningSummary] = useState("detailed");
  const [messages, setMessages] = useState<StudioMessage[]>([]);
  // System prompt injection — default off, user toggles in Options popover.
  const [systemPromptOverride, setSystemPromptOverride] = useState("");
  const [systemPromptEnabled, setSystemPromptEnabled] = useState(false);
  // System Prompt Bokep — bundled character prompt (Jinhsi), default off.
  const [bokepEnabled, setBokepEnabled] = useState(false);
  const syncedIdRef = useRef<string | null>(null);
  const skipSaveRef = useRef(true);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingPatchRef = useRef<Partial<StudioMessage> | null>(null);
  const patchFrameRef = useRef<number | null>(null);

  const flushPatch = useCallback(() => {
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = null;
    if (patch) setMessages((prev) => { const next = [...prev]; const last = next[next.length - 1]; if (last) next[next.length - 1] = { ...last, ...patch }; return next; });
    patchFrameRef.current = null;
  }, []);
  const patchLast = useCallback((patch: Partial<StudioMessage>) => {
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    if (patchFrameRef.current === null) patchFrameRef.current = requestAnimationFrame(flushPatch);
  }, [flushPatch]);
  useEffect(() => () => { abortRef.current?.abort(); if (patchFrameRef.current !== null) cancelAnimationFrame(patchFrameRef.current); }, []);

  if (sessionQuery.data && syncedIdRef.current !== sessionQuery.data.id) {
    syncedIdRef.current = sessionQuery.data.id; skipSaveRef.current = true;
    setTitle(sessionQuery.data.title); setModel(sessionQuery.data.model); setSystemPrompt(sessionQuery.data.systemPrompt); setMessages(sessionQuery.data.messages);
  }

  useEffect(() => {
    if (!activeId || activeId !== syncedIdRef.current || sending) return;
    if (skipSaveRef.current) { skipSaveRef.current = false; return; }
    const timer = setTimeout(() => {
      const persisted = messages.map(({ role, content, ts, reasoning, images, usage, ttfbMs, completionMs }) => ({ role, content, ts, reasoning, images, usage, ttfbMs, completionMs }));
      void apiPatch(`/model-studio/sessions/${activeId}`, { title, model, systemPrompt, messages: persisted })
        .then(() => void queryClient.invalidateQueries({ queryKey: qk.modelStudio.sessions }))
        .catch((err) => { if (err instanceof ApiError && err.status === 404) { syncedIdRef.current = null; setActiveId(null); void queryClient.invalidateQueries({ queryKey: qk.modelStudio.sessions }); return; } toast.error("Failed to save session"); });
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [title, model, systemPrompt, messages, activeId, sending]);

  useEffect(() => setAutoFollowMessages(true), [activeId]);

  // Track the byte length of the last message so we auto-scroll during
  // streaming (content grows without messages.length changing).
  const lastMessageSig = messages.length > 0 ? `${messages.length}:${messages[messages.length - 1]!.content.length}:${messages[messages.length - 1]!.reasoning?.length ?? 0}` : "";
  useLayoutEffect(() => {
    if (!autoFollowMessages) return;
    const frame = requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "auto" }); });
    return () => cancelAnimationFrame(frame);
  }, [activeId, lastMessageSig, autoFollowMessages]);

  const onMessagesScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    setAutoFollowMessages(scrollHeight - scrollTop - clientHeight < 48);
  };

  const deleteSession = useMutation({
    mutationFn: (id: string) => apiDelete<{ ok: boolean }>(`/model-studio/sessions/${id}`),
    onSuccess: (_res, id) => { void queryClient.invalidateQueries({ queryKey: qk.modelStudio.sessions }); if (activeId === id) setActiveId(null); setDeleteTarget(null); toast.success("Session deleted"); },
    onError: () => toast.error("Failed to delete session"),
  });

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [imageMode, setImageMode] = useState(false);
  const [imageCapable, setImageCapable] = useState(false);
  const handleModelCapabilityChange = useCallback((images: boolean) => { setImageCapable(images); if (!images) setImageMode(false); }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) { toast.error(`Up to ${MAX_ATTACHMENTS} images per message`); return; }
    const oversized = images.some((f) => f.size > MAX_ATTACHMENT_BYTES);
    if (oversized) toast.error("Skipped an image over 8MB");
    const accepted = images.filter((f) => f.size <= MAX_ATTACHMENT_BYTES).slice(0, room);
    const read = await Promise.all(accepted.map(async (file) => ({ id: crypto.randomUUID(), name: file.name || "pasted-image", dataUrl: await fileToDataUrl(file) })));
    setAttachments((prev) => [...prev, ...read]);
  };
  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const toggleThinking = useCallback((index: number) => setExpandedThinking((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next; }), []);
  const onEditMessage = useCallback((index: number) => { const m = messagesRef.current[index]; if (!m) return; setEditingMessageIndex(index); setEditingMessageDraft(m.content); }, []);
  const onSaveEdit = useCallback(() => {
    if (editingMessageIndex === null) return;
    const editedIndex = editingMessageIndex;
    const editedText = editingMessageDraft.trim();
    setEditingMessageIndex(null);
    setEditingMessageDraft("");
    if (!editedText) return;
    // Truncate everything after the edited message, update its content,
    // then auto-send to regenerate the response.
    setMessages((c) => c.slice(0, editedIndex + 1).map((m, idx) => idx === editedIndex ? { ...m, content: editedText, reasoning: undefined, usage: undefined, ttfbMs: undefined, completionMs: undefined } : m));
    setExpandedThinking((c) => new Set([...c].filter((i) => i <= editedIndex)));
    setAutoFollowMessages(true);
    // Defer send to next tick so state update flushes first.
    void Promise.resolve().then(() => void sendWithMessages(editedIndex + 1));
  }, [editingMessageDraft, editingMessageIndex]);

  /**
   * Core streaming logic — sends all messages up to `assistantInsertIndex`
   * as history, appends an empty assistant message, and streams the response.
   * Shared by `send` (normal) and `onSaveEdit` (edit → auto-resend).
   * Auto-retries up to 3 times on error or empty response.
   */
  const streamResponse = useCallback(async (history: StudioMessage[], assistantIndex: number) => {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const sendStartTime = performance.now();
      setSending(true);
      // Reset accumulator state for each attempt.
      let textAcc = ""; let reasoningAcc = ""; let usageAcc: StudioUsage | null = null; let ttfbMs: number | undefined;
      // Clear the assistant message for this attempt.
      patchLast({ content: "", reasoning: undefined, usage: undefined, ttfbMs: undefined, completionMs: undefined });
      // Build payload messages: inject system prompt override if enabled,
      // otherwise use bokep prompt if enabled, otherwise session system prompt.
      const effectiveSystemPrompt = systemPromptEnabled && systemPromptOverride.trim() ? systemPromptOverride.trim() : bokepEnabled ? jinhsiPromptText.trim() : systemPrompt.trim();
      const payloadMessages = [...(effectiveSystemPrompt ? [{ role: "system", content: effectiveSystemPrompt }] : []), ...history.map((msg) => ({ role: msg.role, content: toWireContent(msg) }))];
      const controller = new AbortController();
      abortRef.current = controller;
      let errored = false;
      let errorMsg = "";
      try {
        await streamModelStudioChat(
          { model: model.trim(), messages: payloadMessages, maxTokens, reasoningEffort: reasoningEffort === "none" || reasoningEffort === "auto" ? undefined : reasoningEffort, reasoningSummary: reasoningEffort === "none" || reasoningEffort === "auto" ? undefined : reasoningSummary },
          {
            onText: (chunk) => { textAcc += chunk; patchLast({ content: textAcc }); },
            onReasoning: (chunk) => { reasoningAcc += chunk; patchLast({ reasoning: reasoningAcc }); },
            onUsage: (usage) => { usageAcc = usage; patchLast({ usage }); },
            onFirstToken: (ms) => { ttfbMs = ms; patchLast({ ttfbMs }); },
          },
          controller.signal
        );
        flushPatch();
        const completionMs = Math.round(performance.now() - sendStartTime);
        if (!usageAcc) {
          const fallback: StudioUsage = { inputTokens: estimateTextTokens(systemPrompt) + history.reduce((t, m) => t + estimateMessageTokens(m), 0), outputTokens: estimateTextTokens(textAcc), reasoningTokens: estimateTextTokens(reasoningAcc), cachedTokens: 0, totalTokens: estimateTextTokens(systemPrompt) + history.reduce((t, m) => t + estimateMessageTokens(m), 0) + estimateTextTokens(textAcc), source: "estimated" };
          usageAcc = fallback; patchLast({ usage: fallback });
        }
        patchLast({ completionMs, ttfbMs });
        if (!textAcc && reasoningAcc) { patchLast({ content: "_(no visible output — see Thinking below)_" }); setExpandedThinking((prev) => new Set(prev).add(assistantIndex)); }
        // Success — we got some content or reasoning. Done.
        if (textAcc || reasoningAcc) return;
        // Empty response (no text, no reasoning) — retry if attempts remain.
        if (attempt < MAX_RETRIES) {
          patchLast({ content: `_(retry ${attempt}/${MAX_RETRIES}…)_` });
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        errorMsg = err instanceof Error ? err.message : "Request failed";
        if (isAbort) { flushPatch(); setSending(false); abortRef.current = null; return; }
        errored = true;
        if (attempt < MAX_RETRIES) {
          patchLast({ content: `_(retry ${attempt}/${MAX_RETRIES}…)_` });
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        // Final attempt failed — show error.
        const completionMs = Math.round(performance.now() - sendStartTime);
        if (!textAcc) patchLast({ content: `⚠ ${errorMsg}`, completionMs });
        toast.error(errorMsg);
      } finally {
        if (errored || attempt === MAX_RETRIES || (textAcc || reasoningAcc)) {
          flushPatch(); setSending(false); abortRef.current = null;
        }
      }
      // If we reached here on the last attempt with no success, break.
      if (attempt === MAX_RETRIES) break;
    }
  }, [maxTokens, model, patchLast, reasoningEffort, systemPrompt, systemPromptEnabled, systemPromptOverride, bokepEnabled, flushPatch]);

  /** Auto-send after edit — reads from messagesRef since state was just set. */
  const sendWithMessages = useCallback(async (upToIndex: number) => {
    const current = messagesRef.current;
    const history = current.slice(0, upToIndex);
    if (history.length === 0 || !model.trim()) return;
    setMessages([...history, { role: "assistant", content: "", ts: new Date().toISOString() }]);
    void streamResponse(history, history.length);
  }, [model, streamResponse]);
  const onCancelEdit = useCallback(() => { setEditingMessageIndex(null); setEditingMessageDraft(""); }, []);
  const onCopyMessage = useCallback(async (m: StudioMessage) => { try { await navigator.clipboard.writeText(m.content); toast.success("Copied"); } catch { toast.error("Copy failed"); } }, []);
  const onDeleteMessage = useCallback((index: number) => { setMessages((c) => c.filter((_, i) => i !== index)); setExpandedThinking((c) => new Set([...c].filter((i) => i !== index).map((i) => i > index ? i - 1 : i))); setEditingMessageIndex(null); }, []);

  const onRetryMessage = useCallback((index: number) => {
    // Retry: remove the failed assistant message and everything after,
    // then re-send from the last user message.
    if (sending) return;
    setMessages((c) => c.slice(0, index));
    setExpandedThinking((c) => new Set([...c].filter((i) => i < index)));
    setAutoFollowMessages(true);
    void Promise.resolve().then(() => void sendWithMessages(index));
  }, [sending, sendWithMessages]);

  const [autoCompactBanner, setAutoCompactBanner] = useState<string | null>(null);
  const autoCompactRef = useRef(false);

  const compactChat = useCallback(async () => {
    if (compacting || !model.trim() || messages.length < 2) return;
    setCompacting(true);
    try {
      // Send messages as { role, content: string } — backend expects string
      // content, not ChatContentPart[]. Images are omitted for compaction.
      const result = await apiPost<{ summary: string; usage?: ChatUsagePayload }>("/model-studio/compact", {
        model: model.trim(), systemPrompt, maxTokens,
        messages: messages.map((m) => ({ role: m.role, content: m.content, ts: m.ts })),
      });
      const usage = result.usage ? studioUsageFromChatUsage(result.usage) : undefined;
      setMessages([{ role: "system", content: `[Compacted context]\n\n${result.summary}`, ts: new Date().toISOString(), ...(usage ? { usage } : {}) }]);
      setExpandedThinking(new Set());
      toast.success("Context compacted");
    } catch (error) { toast.error(getErrorMessage(error, "Compaction failed")); }
    finally { setCompacting(false); }
  }, [compacting, maxTokens, messages, model, systemPrompt]);

  // Auto-compact when context reaches 80% of the model's context window.
  // We check after each message exchange completes (not during streaming).
  useEffect(() => {
    if (sending || compacting || messages.length < 4 || autoCompactRef.current) return;
    if (!model.trim()) return;
    const snapshot = getTokenSnapshot(messages, systemPrompt);
    // Estimate the model's context limit from lookupModelData via the snapshot.
    // We use a conservative default of 128k if unknown.
    const contextLimit = 128_000;
    const usageRatio = snapshot.inputTokens / contextLimit;
    if (usageRatio >= 0.8) {
      autoCompactRef.current = true;
      setAutoCompactBanner("Context at 80% — auto-compacting…");
      toast.success("Context at 80%", { description: "Auto-compacting conversation history…" });
      void compactChat().finally(() => {
        setAutoCompactBanner(null);
        autoCompactRef.current = false;
      });
    }
  }, [sending, compacting, messages, systemPrompt, model, compactChat]);

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || !model.trim() || sending) return;
    const images = attachments.map((a) => a.dataUrl);
    const sendStartTime = performance.now();

    if (imageMode) {
      setDraft(""); setAttachments([]);
      setMessages([...messages, { role: "user", content: text, ts: new Date().toISOString(), ...(images.length > 0 ? { images } : {}) }, { role: "assistant", content: "", ts: new Date().toISOString() }]);
      setSending(true);
      try { const result = await apiPost<{ data?: Array<{ b64_json?: string }> }>("/model-studio/image", { model: model.trim(), prompt: text || "Create an image from the attached reference.", ...(images.length > 0 ? { images } : {}) }); const generated = (result.data ?? []).flatMap((e) => typeof e.b64_json === "string" ? [`data:image/webp;base64,${e.b64_json}`] : []); patchLast({ content: generated.length > 0 ? `Generated ${generated.length} image${generated.length === 1 ? "" : "s"}.` : "No image returned.", completionMs: Math.round(performance.now() - sendStartTime), ...(generated.length > 0 ? { images: generated } : {}) }); }
      catch (error) { patchLast({ content: `⚠ ${getErrorMessage(error, "Image request failed")}`, completionMs: Math.round(performance.now() - sendStartTime) }); }
      finally { flushPatch(); setSending(false); }
      return;
    }

    setDraft(""); setAttachments([]);
    const userMessage: StudioMessage = { role: "user", content: text, ts: new Date().toISOString(), ...(images.length > 0 ? { images } : {}) };
    const history = [...messages, userMessage];
    const assistantIndex = history.length;
    setMessages([...history, { role: "assistant", content: "", ts: new Date().toISOString() }]);
    void streamResponse(history, assistantIndex);
  };

  const activeSummary = sessions.find((s) => s.id === activeId);

  return (
    <Card className="dashboard-page flex h-[calc(100dvh-102px)] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:h-[calc(100dvh-118px)]">
      {/* Session bar — compact, mobile-first */}
      <div className="flex items-center gap-2 border-b border-[var(--inner-border)] px-3 py-2 sm:px-4 sm:py-2.5">
        <SessionPicker sessions={sessions} activeId={activeId} onSelect={setActiveId} onCreate={() => createSession.mutate("New chat")} creating={createSession.isPending} />
        <div className="ml-auto flex items-center gap-1.5">
          <PromptPopover maxTokens={maxTokens} onMaxTokens={setMaxTokens} reasoningEffort={reasoningEffort} onReasoningEffort={setReasoningEffort} reasoningSummary={reasoningSummary} onReasoningSummary={setReasoningSummary} providerId={model.split("/")[0] || undefined} systemPromptOverride={systemPromptOverride} onSystemPromptOverride={setSystemPromptOverride} systemPromptEnabled={systemPromptEnabled} onSystemPromptEnabled={setSystemPromptEnabled} bokepEnabled={bokepEnabled} onBokepEnabled={setBokepEnabled} title={title} onTitleChange={setTitle} />
          <Button variant="secondary" size="icon" className="h-8 w-8 shrink-0 text-[var(--red)]" onClick={() => activeId && setDeleteTarget(activeId)} disabled={!activeId} aria-label="Delete" title="Delete"><Trash2 size={14} /></Button>
        </div>
      </div>
      {sessionsQuery.isError && <div role="alert" className="border-b border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-3 py-1.5 text-[10px] text-[var(--status-warning)]">Session storage unavailable. Messages stay local until recovered.</div>}
      {sessionQuery.isError && <div role="alert" className="border-b border-[var(--status-danger)]/30 bg-[var(--status-danger)]/10 px-3 py-1.5 text-[10px] text-[var(--status-danger)]">Session load failed. Select another or create new.</div>}

      {/* Messages — iOS-style scroll area */}
      <div ref={scrollRef} onScroll={onMessagesScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-2 sm:space-y-3 sm:px-4 sm:py-3">
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 text-center text-[var(--text-3)] sm:min-h-[200px]">
            <Bot size={24} /><p className="text-[11px]">Pick a model and send a message to start.</p>
          </div>
        ) : (
          <>
        {autoCompactBanner && (
          <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-[var(--accent)]/35 bg-[var(--accent-soft)] px-3 py-1.5 text-[10px] font-medium text-[var(--accent)]">
            <Loader2 size={12} className="animate-spin" /> {autoCompactBanner}
          </div>
        )}
        {compacting && !autoCompactBanner && <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-dashed border-[var(--accent)]/35 bg-[var(--accent-soft)] px-3 py-1.5 text-[10px] text-[var(--accent)]"><Loader2 size={12} className="animate-spin" /> Compacting…</div>}
            {messages.map((message, index) => (
              <MessageRow key={message.ts + index} message={message} index={index} isStreaming={sending && index === messages.length - 1} thinkingOpen={expandedThinking.has(index) || (sending && index === messages.length - 1)} editing={editingMessageIndex === index} editDraft={editingMessageDraft} onEditDraft={setEditingMessageDraft} onEdit={onEditMessage} onSaveEdit={onSaveEdit} onCancelEdit={onCancelEdit} onCopy={onCopyMessage} onDelete={onDeleteMessage} onThinkingToggle={toggleThinking} onRetry={onRetryMessage} />
            ))}
          </>
        )}
      </div>

      {/* Composer — compact, ChatGPT-style */}
      <div className="border-t border-[var(--inner-border)] p-2">
        <div className="rounded-2xl border border-[var(--inner-border)] bg-[var(--hover)] p-1.5 shadow-[0_2px_8px_rgba(0,0,0,0.06)] transition-colors focus-within:border-[var(--accent)] focus-within:bg-[var(--glass-bg-2)] sm:p-2">
          {attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5 px-1 pt-1">
              {attachments.map((a) => (
                <div key={a.id} className="group relative h-12 w-12 shrink-0 sm:h-14 sm:w-14">
                  <img src={a.dataUrl} alt={a.name} className="h-full w-full rounded-lg border border-[var(--inner-border)] object-cover" />
                  <button type="button" onClick={() => removeAttachment(a.id)} aria-label={`Remove ${a.name}`} className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-[var(--red)] text-white shadow transition-transform group-hover:scale-110"><X size={8} /></button>
                </div>
              ))}
            </div>
          )}
          <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} onPaste={(e) => { const files = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((f): f is File => f !== null); if (files.length > 0) { e.preventDefault(); void addFiles(files); } }} placeholder="Message…" data-model-studio-composer rows={1} className="min-h-[36px] max-h-24 resize-none overflow-y-auto border-0 bg-transparent px-2 py-1 text-[13px] shadow-none focus:bg-transparent focus-visible:outline-0" />
          <div className="flex flex-wrap items-center gap-1 border-t border-[var(--inner-border)] pt-1.5">
            <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
            <ConfiguredModelPicker value={model} onChange={setModel} includeCombos includeAliases onCapabilityChange={handleModelCapabilityChange} placeholder="Select model…" />
            <ContextIndicator messages={messages} systemPrompt={systemPrompt} compacting={compacting} onCompact={() => void compactChat()} />
            <div className="ml-auto flex items-center gap-1">
              {imageCapable && <Button variant="secondary" size="icon" onClick={() => setImageMode((v) => !v)} aria-label={imageMode ? "Chat mode" : "Image mode"} title={imageMode ? "Chat mode" : "Image generation"} className={cn(imageMode && "border-[var(--accent)] text-[var(--accent)]")}><ImagePlus size={14} /></Button>}
              <Button variant="secondary" size="icon" onClick={() => fileInputRef.current?.click()} aria-label="Attach image" title="Attach image"><Paperclip size={14} /></Button>
              {sending ? <Button variant="secondary" size="icon" onClick={() => abortRef.current?.abort()} aria-label="Stop"><Square size={14} /></Button> : <Button size="icon" onClick={() => void send()} disabled={(!draft.trim() && attachments.length === 0) || !model.trim()} aria-label="Send"><Send size={14} /></Button>}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} onConfirm={() => deleteTarget && deleteSession.mutate(deleteTarget)} title="Delete session?" message={`Delete "${activeSummary?.title ?? "this session"}" and its messages? This can't be undone.`} danger confirmLabel="Delete" />
    </Card>
  );
}
