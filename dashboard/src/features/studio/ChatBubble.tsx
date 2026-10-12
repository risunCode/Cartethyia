import { AlertCircle, ArrowDown, ArrowUp, Bot, Brain, Check, ChevronDown, Copy, DatabaseZap, Gauge, Pencil, RotateCcw, Sigma, Timer, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LabMessage } from "./session";




function modelName(model: string | undefined): string {
  if (model === undefined || model.length === 0) return "";
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

function providerName(model: string | undefined): string {
  if (model === undefined) return "";
  const slash = model.indexOf("/");
  return slash === -1 ? "" : model.slice(0, slash);
}

function duration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(1))}s`;
  return `${Math.round(ms)}ms`;
}

function count(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function thinkingText(text: string): string {
  const trimmed = text.replace(/\r/g, "").trim();
  if (trimmed.length === 0 || /^[.\u2026…]+$/.test(trimmed)) return "";
  return text.replace(/\r/g, "").replace(/^\n+|\n+$/g, "");
}



/**
 * One turn with a face, not a bare pill.
 *
 * You and the model each get an icon. The bubble shows only the model name
 * that answered that turn; the provider appears on hover. Thinking stays
 * open while it is arriving, five lines at a time, older lines scrolling up,
 * then collapses once the answer starts.
 */
export function ChatBubble({
  message,
  onEdit,
  onRetry,
  retryDisabled = false,
}: {
  readonly message: LabMessage;
  readonly onEdit?: (text: string) => void;
  readonly onRetry?: () => void;
  readonly retryDisabled?: boolean;
}): ReactNode {
  const mine = message.role === "user";
  const thinking = thinkingText(message.reasoning ?? "");
  const live = message.pending === true && message.error !== true;
  const waiting = live && message.text.length === 0 && thinking.length === 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(thinking.length > 0 && message.text.length === 0);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const thinkingAtBottomRef = useRef(true);
  const name = modelName(message.model);
  const provider = providerName(message.model);
  const totalTokens = (message.usage?.inputTokens ?? 0) + (message.usage?.outputTokens ?? 0);
  const total = message.usage?.inputTokens === undefined && message.usage?.outputTokens === undefined ? null : count(totalTokens);
  const tokenSpeed =
    message.usage?.outputTokens !== undefined && message.usage?.completionMs !== undefined && message.usage.completionMs > 0
      ? `${Math.round(message.usage.outputTokens / (message.usage.completionMs / 1000))}/s`
      : null;
  const metrics = mine
    ? []
    : [
        duration(message.usage?.ttftMs) === null ? null : { icon: <Timer size={10} />, label: "Time to first token", value: duration(message.usage?.ttftMs) ?? "" },
        count(message.usage?.inputTokens) === null ? null : { icon: <ArrowUp size={10} />, label: "Input tokens", value: count(message.usage?.inputTokens) ?? "" },
        count(message.usage?.cachedTokens) === null ? null : { icon: <DatabaseZap size={10} />, label: "Cached tokens", value: count(message.usage?.cachedTokens) ?? "" },
        count(message.usage?.outputTokens) === null ? null : { icon: <ArrowDown size={10} />, label: "Output tokens", value: count(message.usage?.outputTokens) ?? "" },
        total === null ? null : { icon: <Sigma size={10} />, label: "Total tokens", value: total },
        tokenSpeed === null ? null : { icon: <Gauge size={10} />, label: "Token speed", value: tokenSpeed },
        duration(message.usage?.completionMs) === null ? null : { icon: <Check size={10} />, label: "Done", value: duration(message.usage?.completionMs) ?? "" },
      ].filter((item) => item !== null);

  useEffect(() => {
    if (thinking.length > 0 && message.text.length === 0) setThinkingOpen(true);
    if (message.text.length > 0) setThinkingOpen(false);
  }, [thinking.length, message.text.length]);

  useEffect(() => {
    const panel = thinkingRef.current;
    if (!thinkingOpen || panel === null || !thinkingAtBottomRef.current) return;
    panel.scrollTop = panel.scrollHeight;
  }, [thinking, thinkingOpen]);

  const copy = async () => {
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={mine ? "mlab-turn flex flex-col w-full max-w-380 gap-2 items-end ml-auto animate-message-in motion-reduce:animate-none" : "mlab-turn flex flex-col w-full max-w-380 gap-2 items-start mr-auto animate-message-in motion-reduce:animate-none"}>
      {mine ? null : (
        <div className="flex items-center gap-3 min-h-12 text-text-tertiary text-caption">
          <span className="grid place-items-center w-11 h-11 rounded-control border border-inner-border bg-surface-2 text-text-secondary" aria-hidden="true">
            <Bot size={13} />
          </span>
          <span className="font-bold text-text-secondary" title={provider.length > 0 ? provider : undefined}>{name || "Model"}</span>
        </div>
      )}

      {thinking.length > 0 ? (
        <div className="flex flex-col gap-3 w-full max-w-280 text-text-tertiary font-sans text-caption">
          <button type="button" className="inline-flex items-center gap-2.5 w-fit h-12 px-4 border border-inner-border rounded-pill bg-surface-2 text-text-secondary font-sans text-badge font-semibold cursor-pointer hover:border-border-strong hover:bg-hover hover:text-text-primary [&_svg]:flex-none [&_svg[data-open=true]]:rotate-180" aria-expanded={thinkingOpen} onClick={() => setThinkingOpen((current) => {
            if (!current) thinkingAtBottomRef.current = true;
            return !current;
          })}>
            <Brain size={12} />
            <span>{live && message.text.length === 0 ? "Thinking" : "Thought"}</span>
            <ChevronDown size={12} data-open={thinkingOpen ? "true" : "false"} />
          </button>
          {thinkingOpen ? (
            <div
              ref={thinkingRef}
              onScroll={(event) => {
                const panel = event.currentTarget;
                thinkingAtBottomRef.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 24;
              }}
              className="scroll-region max-h-[calc(1.5em*5)] overflow-auto px-5 py-4 border border-inner-border rounded-control bg-surface-2 text-text-secondary leading-normal select-text cursor-text [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{thinking}</ReactMarkdown>
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className={
          mine
            ? "max-w-full max-medium:max-w-[88%] text-lead leading-[1.35] wrap-break-word px-7 py-4 border border-border-strong rounded-hero rounded-br-tiny bg-surface-active text-text-primary whitespace-pre-wrap"
            : message.error === true
              ? "max-w-full max-medium:max-w-[88%] text-lead leading-[1.35] wrap-break-word py-1 pr-1 text-red"
              : "max-w-full max-medium:max-w-[88%] text-lead leading-[1.35] wrap-break-word py-1 pr-1 text-text-primary"
        }
      >
        {waiting ? (
          <span className="inline-flex items-center gap-2 h-11 px-2 text-text-tertiary text-caption" aria-label="Model is thinking">
            <span className="w-3 h-3 rounded-full bg-text-tertiary animate-typing-bounce motion-reduce:animate-none" />
            <span className="w-3 h-3 rounded-full bg-text-tertiary animate-typing-bounce motion-reduce:animate-none [animation-delay:0.15s]" />
            <span className="w-3 h-3 rounded-full bg-text-tertiary animate-typing-bounce motion-reduce:animate-none [animation-delay:0.3s]" />
            <span>Thinking…</span>
          </span>
        ) : editing ? (
          <form
            className="flex flex-col gap-4 min-w-140 max-w-[70vw]"
            onSubmit={(event) => {
              event.preventDefault();
              onEdit?.(draft);
              setEditing(false);
            }}
          >
            <textarea value={draft} aria-label="Edit message" onChange={(event) => setDraft(event.target.value)} className="w-full min-h-32 border-0 outline-none resize-y bg-transparent text-text-primary caret-text-primary font-sans" />
            <span className="flex justify-end gap-3">
              <button type="button" onClick={() => setEditing(false)} className="h-13 px-5 border-0 rounded-pill bg-hover text-text-secondary text-caption font-semibold cursor-pointer hover:bg-surface-hover">Cancel</button>
              <button type="submit" className="h-13 px-5 border-0 rounded-pill bg-text-primary text-surface-1 text-caption font-semibold cursor-pointer">Send</button>
            </span>
          </form>
        ) : (
          <>
            {(message.images?.length ?? 0) > 0 ? (
              <div className="flex flex-wrap gap-2 mb-1">
                {message.images?.map((image) => (
                  <img key={image.dataUrl} src={image.dataUrl} alt={image.name} className="w-20 h-20 object-cover rounded-control border border-inner-border" />
                ))}
              </div>
            ) : null}
            {(message.tools?.length ?? 0) > 0 ? (
              <div className="flex flex-wrap gap-3 mb-4">
                {message.tools?.map((tool) => (
                  <span key={tool} className="inline-flex items-center gap-2.5 h-12 px-4.5 border border-border-strong rounded-pill bg-surface-1 text-text-secondary text-badge leading-none whitespace-nowrap [&_svg]:text-accent">
                    <Wrench size={11} aria-hidden="true" />
                    <span>{tool}</span>
                  </span>
                ))}
              </div>
            ) : null}
            {mine ? (
              message.text.length > 0 ? message.text : null
            ) : message.text.length > 0 ? (
              <div className="min-w-0 font-sans text-body-lg leading-normal [&_p]:m-0 [&_p]:mb-4 [&_ul]:m-0 [&_ul]:mb-4 [&_ol]:m-0 [&_ol]:mb-4 [&_pre]:m-0 [&_pre]:mb-4 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0 [&_pre:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:px-6 [&_pre]:py-5 [&_pre]:rounded-control [&_pre]:bg-surface-muted [&_pre]:font-mono [&_pre]:text-caption [&_code]:font-mono [&_svg]:flex-none [&_svg]:mt-1.5">
                {message.error === true ? <AlertCircle size={14} aria-hidden="true" /> : null}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                {live ? <span className="ml-1 text-accent animate-pulse motion-reduce:animate-none" aria-hidden="true">▋</span> : null}
              </div>
            ) : null}
          </>
        )}
      </div>
      {mine && !editing ? (
        <div className="inline-flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 hover:opacity-100 [.mlab-turn:hover_&]:opacity-100 [.mlab-turn:focus-within_&]:opacity-100">
          <button type="button" aria-label="Copy message" title="Copy" onClick={() => void copy()} className="inline-flex items-center justify-center w-11 h-11 p-0 border-0 rounded-chip bg-transparent text-text-tertiary cursor-pointer hover:bg-hover hover:text-text-primary">
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          {onEdit !== undefined ? (
            <button type="button" aria-label="Edit and resend" title="Edit and resend" onClick={() => { setDraft(message.text); setEditing(true); }} className="inline-flex items-center justify-center w-11 h-11 p-0 border-0 rounded-chip bg-transparent text-text-tertiary cursor-pointer hover:bg-hover hover:text-text-primary">
              <Pencil size={12} />
            </button>
          ) : null}
          {onRetry !== undefined ? (
            <button type="button" aria-label="Retry response" title="Retry response" disabled={retryDisabled} onClick={onRetry} className="inline-flex items-center justify-center w-11 h-11 p-0 border-0 rounded-chip bg-transparent text-text-tertiary cursor-pointer hover:bg-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-default">
              <RotateCcw size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {metrics.length > 0 || (!mine && message.text.length > 0) ? (
        <div className="inline-flex items-center h-8 rounded-tiny bg-surface-muted text-text-tertiary overflow-hidden [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1 [&>span]:h-8 [&>span]:px-2.5 [&>span]:border-0 [&>span]:border-r [&>span]:border-r-inner-border [&>span]:bg-transparent [&>span]:text-inherit [&>span]:font-sans [&>span]:text-micro [&>span]:leading-none [&>span]:tabular-nums [&>span:last-child]:border-r-0 [&_svg]:flex-none [&>button]:cursor-pointer">
          {metrics.map((item) => (
            <span key={item.label} title={item.label}>
              {item.icon}
              <span>{item.value}</span>
            </span>
          ))}
          {!mine && message.text.length > 0 ? (
            <button type="button" aria-label="Copy message" title="Copy" onClick={() => void copy()}>
              {copied ? <Check size={10} /> : <Copy size={10} />}
            </button>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}
