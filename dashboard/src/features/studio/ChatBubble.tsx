import { AlertCircle, ArrowDown, ArrowUp, Bot, Brain, Check, ChevronDown, Copy, DatabaseZap, Pencil, Sigma, Timer } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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

function thinkingLines(text: string): readonly string[] {
  const lines = text.split("\n");
  return lines.length > 0 ? lines : [text];
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
}: {
  readonly message: LabMessage;
  readonly onEdit?: (text: string) => void;
}): ReactNode {
  const mine = message.role === "user";
  const thinking = thinkingText(message.reasoning ?? "");
  const live = message.pending === true && message.error !== true;
  const waiting = live && message.text.length === 0 && thinking.length === 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [copied, setCopied] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(thinking.length > 0 && message.text.length === 0);
  const name = modelName(message.model);
  const provider = providerName(message.model);
  const totalTokens = (message.usage?.inputTokens ?? 0) + (message.usage?.outputTokens ?? 0);
  const total = message.usage?.inputTokens === undefined && message.usage?.outputTokens === undefined ? null : count(totalTokens);
  const metrics = mine
    ? []
    : [
        duration(message.usage?.ttftMs) === null ? null : { icon: <Timer size={10} />, label: "Time to first token", value: duration(message.usage?.ttftMs) ?? "" },
        count(message.usage?.inputTokens) === null ? null : { icon: <ArrowUp size={10} />, label: "Input tokens", value: count(message.usage?.inputTokens) ?? "" },
        count(message.usage?.cachedTokens) === null ? null : { icon: <DatabaseZap size={10} />, label: "Cached tokens", value: count(message.usage?.cachedTokens) ?? "" },
        count(message.usage?.outputTokens) === null ? null : { icon: <ArrowDown size={10} />, label: "Output tokens", value: count(message.usage?.outputTokens) ?? "" },
        total === null ? null : { icon: <Sigma size={10} />, label: "Total tokens", value: total },
        duration(message.usage?.completionMs) === null ? null : { icon: <Check size={10} />, label: "Done", value: duration(message.usage?.completionMs) ?? "" },
      ].filter((item) => item !== null);

  useEffect(() => {
    if (thinking.length > 0 && message.text.length === 0) setThinkingOpen(true);
    if (message.text.length > 0 && !live) setThinkingOpen(false);
  }, [thinking.length, message.text.length, live]);

  const copy = async () => {
    await navigator.clipboard.writeText(message.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={mine ? "mlab-turn mlab-turn-user mlab-msg-in" : "mlab-turn mlab-turn-assistant mlab-msg-in"}>
      {mine ? null : (
        <div className="mlab-profile">
          <span className="mlab-avatar" aria-hidden="true">
            <Bot size={13} />
          </span>
          <span className="mlab-who" title={provider.length > 0 ? provider : undefined}>{name || "Model"}</span>
        </div>
      )}

      {thinking.length > 0 ? (
        <div className="mlab-thinking">
          <button type="button" className="mlab-thinking-toggle" aria-expanded={thinkingOpen} onClick={() => setThinkingOpen((current) => !current)}>
            <Brain size={12} />
            <span>{live && message.text.length === 0 ? "Thinking" : "Thought"}</span>
            <ChevronDown size={12} data-open={thinkingOpen ? "true" : "false"} />
          </button>
          {thinkingOpen ? (
            <div className="mlab-thinking-window">{thinking}</div>
          ) : null}
        </div>
      ) : null}
      <div
        className={
          mine
            ? "mlab-bubble mlab-bubble-user"
            : message.error === true
              ? "mlab-bubble mlab-bubble-assistant mlab-bubble-error"
              : "mlab-bubble mlab-bubble-assistant"
        }
      >
        {waiting ? (
          <span className="mlab-typing" aria-label="Model is writing">
            <span className="mlab-typing-dot" />
            <span className="mlab-typing-dot" />
            <span className="mlab-typing-dot" />
          </span>
        ) : editing ? (
          <form
            className="mlab-edit"
            onSubmit={(event) => {
              event.preventDefault();
              onEdit?.(draft);
              setEditing(false);
            }}
          >
            <textarea value={draft} aria-label="Edit message" onChange={(event) => setDraft(event.target.value)} />
            <span>
              <button type="button" onClick={() => setEditing(false)}>Cancel</button>
              <button type="submit">Send</button>
            </span>
          </form>
        ) : (
          <>
            {(message.images?.length ?? 0) > 0 ? (
              <div className="mlab-images">
                {message.images?.map((image) => (
                  <img key={image.dataUrl} src={image.dataUrl} alt={image.name} />
                ))}
              </div>
            ) : null}
            {mine ? (
              message.text.length > 0 ? message.text : null
            ) : message.text.length > 0 ? (
              <div className="mlab-markdown">
                {message.error === true ? <AlertCircle size={14} aria-hidden="true" /> : null}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
              </div>
            ) : null}
          </>
        )}
      </div>
      {mine && !editing ? (
        <div className="mlab-turn-actions">
          <button type="button" aria-label="Copy message" title="Copy" onClick={() => void copy()}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          {onEdit !== undefined ? (
            <button type="button" aria-label="Edit and resend" title="Edit and resend" onClick={() => { setDraft(message.text); setEditing(true); }}>
              <Pencil size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {metrics.length > 0 || (!mine && message.text.length > 0) ? (
        <div className="mlab-meter">
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
