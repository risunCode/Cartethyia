import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import {
  Brain,
  ChevronDown,
  ChevronUp,
  Feather,
  FileAudio,
  FileText,
  Globe,
  MessageSquareText,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { ModelPickerModal, useAllModelsCatalog } from "../components/ModelPicker";
import type {
  StudioAttachment,
  StudioMessage,
  StudioSessionView,
} from "../lib/contracts";
import {
  useCreateStudioSession,
  useDeleteStudioSession,
  usePatchStudioSession,
  useStudioKey,
  useStudioSession,
  useStudioSessions,
} from "../lib/hooks/studio";
import { createChatStreamAccumulator, pumpChatStream } from "../lib/studio-stream";
import type { ChatStreamAccumulator } from "../lib/studio-stream";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import { formatBytes } from "../lib/format";
import {
  ACTIVE_KEY,
  STUDIO_KEY_STORAGE,
  STUDIO_PREFIX_STORAGE,
  readStorage,
  writeLocal,
  writeSession,
} from "../lib/studio-session-storage";
import {
  LOCAL_TOOL_DEFS,
  MAX_TOOL_TURNS,
  TOOL_DEFS,
  executeStudioToolAsync,
  webToolsExplicitlyRequested,
} from "./model-lab/tools";
import {
  ACCEPT_STRING,
  MAX_ATTACH_BYTES,
  MAX_ATTACHMENTS,
  attachmentToWirePart,
  autoTitle,
  downscaleImage,
  kindForMime,
  readFileAsDataURL,
} from "../components/studio/attachments";
import { Markdown } from "../components/studio/markdown";
import { Avatar, CopyButton, MessageMeta, Thinking, ToolChips } from "../components/studio/message-parts";

const THINK_LEVELS = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "xHigh" },
  { value: "max", label: "Max" },
] as const;
type ThinkLevel = (typeof THINK_LEVELS)[number]["value"];


const SUGGESTIONS = [
  { label: "Test tool calling: use printf to print hello", icon: Wrench },
  { label: "Think step by step through a tricky logic puzzle", icon: Brain },
  { label: "Explain how TCP retransmission works, briefly", icon: Globe },
  { label: "Write a haiku about packet loss", icon: Feather },
] as const;

interface PendingUser {
  readonly ts: string;
  readonly content: string;
  readonly attachments?: readonly StudioAttachment[];
}

/**
 * Rebuilds OpenAI wire history from a persisted transcript, minting fresh
 * pairing ids per request so old tool turns replay with their results
 * intact — even turns recorded before tool support existed. Attachments
 * ride as multimodal content parts on user turns.
 */
export function toWireHistory(
  systemPrompt: string,
  messages: readonly StudioMessage[],
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  if (systemPrompt.trim().length > 0) wire.push({ role: "system", content: systemPrompt });
  messages.forEach((message, messageIndex) => {
    if (message.role === "system") {
      wire.push({ role: "system", content: message.content });
      return;
    }
    if (message.role === "user") {
      const attachments = message.attachments ?? [];
      if (attachments.length === 0) {
        wire.push({ role: "user", content: message.content });
        return;
      }
      const parts: Array<Record<string, unknown>> = [];
      if (message.content.length > 0) parts.push({ type: "text", text: message.content });
      for (const attachment of attachments) {
        const part = attachmentToWirePart(attachment);
        if (part) parts.push(part);
      }
      wire.push({ role: "user", content: parts });
      return;
    }
    const rounds = message.toolRounds ?? [];
    if (rounds.length === 0) {
      wire.push({ role: "assistant", content: message.content });
      return;
    }
    rounds.forEach((round, roundIndex) => {
      const callIds = round.toolCalls.map(
        (_call, callIndex) => `studio-${messageIndex}-${roundIndex}-${callIndex}`,
      );
      wire.push({
        role: "assistant",
        content: null,
        tool_calls: round.toolCalls.map((call, callIndex) => ({
          id: callIds[callIndex],
          type: "function",
          function: { name: call.name, arguments: call.args },
        })),
      });
      round.toolCalls.forEach((call, callIndex) => {
        wire.push({
          role: "tool",
          tool_call_id: callIds[callIndex],
          content: call.result,
        });
      });
    });
    if (message.content.length > 0 && message.content !== "(no visible output)") {
      wire.push({ role: "assistant", content: message.content });
    }
  });
  return wire;
}

function ChatTimeline({
  messages,
  model,
  onScrollTo,
}: {
  messages: readonly StudioMessage[];
  model: string;
  onScrollTo: (index: number) => void;
}): ReactNode {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(0);

  useEffect(() => {
    const scroller = document.querySelector(".app-main-column");
    if (!scroller) return;

    let rafId: number | null = null;
    function updateActive() {
      if (!scroller || messages.length === 0) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const targetY = scrollerRect.top + scrollerRect.height * 0.38;

      let closest = 0;
      let minDistance = Infinity;

      for (let i = 0; i < messages.length; i++) {
        const el = document.getElementById(`mlab-msg-${i}`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const dist = Math.abs(rect.top - targetY);
        if (dist < minDistance) {
          minDistance = dist;
          closest = i;
        }
      }
      setActiveIndex(closest);
    }

    function onScroll() {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          updateActive();
        });
      }
    }

    updateActive();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [messages.length]);

  if (messages.length <= 1) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-label="Conversation timeline"
      style={{
        position: "fixed",
        right: "42px",
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 35,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: "4px",
        padding: "8px 4px",
      }}
    >
      {/* Vertical background track line */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          right: "8px",
          top: "8px",
          bottom: "8px",
          width: "1px",
          background: "color-mix(in srgb, var(--inner-border) 45%, transparent)",
          pointerEvents: "none",
        }}
      />

      {messages.map((msg, index) => {
        const isHovered = hoveredIndex === index;
        const isActive = activeIndex === index;
        const isSelected = isHovered || isActive;
        const isUser = msg.role === "user";
        const snippet =
          msg.content.trim() ||
          (msg.attachments && msg.attachments.length > 0 ? "Attachment" : "Message");
        const preview = snippet.length > 75 ? `${snippet.slice(0, 72)}…` : snippet;
        const roleLabel = isUser ? "You" : model ? model.split("/").slice(-1)[0] : "Assistant";

        return (
          <div
            key={`${msg.ts}-${index}`}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              height: "16px",
              padding: "0 2px",
              cursor: "pointer",
            }}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
            onClick={() => onScrollTo(index)}
          >
            {/* Sneak peek tooltip card on hover */}
            {isHovered ? (
              <div
                style={{
                  position: "absolute",
                  right: "calc(100% + 10px)",
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "var(--popover-bg)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "10px",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                  padding: "6px 10px",
                  maxWidth: "260px",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  pointerEvents: "none",
                  zIndex: 50,
                }}
              >
                <div
                  style={{
                    fontSize: "9.5px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: isUser ? "var(--accent)" : "var(--text-tertiary)",
                    marginBottom: "2px",
                  }}
                >
                  {roleLabel}
                </div>
                <div
                  style={{
                    fontSize: "11.5px",
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {preview}
                </div>
              </div>
            ) : null}

            {/* Horizontal tick mark line */}
            {/* Horizontal tick mark line with active scroll glow */}
            <span
              style={{
                display: "block",
                width: isHovered ? "18px" : isActive ? "14px" : "8px",
                height: isSelected ? "3px" : "2px",
                borderRadius: "2px",
                background: isHovered
                  ? "var(--text-primary)"
                  : isActive
                    ? "var(--accent)"
                    : isUser
                      ? "color-mix(in srgb, var(--text-secondary) 75%, transparent)"
                      : "color-mix(in srgb, var(--text-tertiary) 50%, transparent)",
                boxShadow: isActive
                  ? "0 0 10px color-mix(in srgb, var(--accent) 50%, transparent)"
                  : "none",
                transform: isActive ? "scaleY(1.2)" : "none",
                transition: "transform var(--dur-micro) var(--ease-spring)",
              }}
            />
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export default function ModelLab(): ReactNode {
  const [activeId, setActiveId] = useState<string | null>(() => readStorage(ACTIVE_KEY));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [think, setThink] = useState<ThinkLevel>("high");
  // Every sampling knob has its own enable switch; the master switch gates
  // the whole group. Off = the field is never sent, so the wire stays
  // byte-identical to a client that never knew the knob existed.
  const [advancedOn, setAdvancedOn] = useState(false);
  const [temperatureOn, setTemperatureOn] = useState(true);
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokensOn, setMaxTokensOn] = useState(false);
  const [maxTokens, setMaxTokens] = useState("");
  const [topPOn, setTopPOn] = useState(false);
  const [topP, setTopP] = useState("1");
  const [logprobsOn, setLogprobsOn] = useState(false);
  const [topLogprobs, setTopLogprobs] = useState("5");
  const [stripEncryptedReasoning, setStripEncryptedReasoning] = useState(false);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<readonly StudioAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [live, setLive] = useState<ChatStreamAccumulator | null>(null);
  const [pendingUser, setPendingUser] = useState<PendingUser | null>(null);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const sessionRef = useRef<HTMLDivElement | null>(null);
  const tuneRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState<{ canScroll: boolean; isAtBottom: boolean }>({
    canScroll: false,
    isAtBottom: true,
  });
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef(false);
  /**
   * Re-entrancy guard for `send()`. `sending` is React state, so reading it
   * inside `send()` sees a stale closure value: rapid clicks (or a preset plus
   * a Retry) all pass the guard before React re-renders, and each one appends
   * the same prompt to the history again. The wire then carries "printf 407"
   * once per click, and the model answers with one parallel tool call per
   * copy. A ref is set synchronously, so it actually blocks.
   */
  const sendingRef = useRef(false);
  const syncedSessionRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  function autoresizeComposer(): void {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }
  // rAF-coalesced live rendering: SSE frames arrive faster (~14ms) than a
  // full markdown re-parse + forced scroll layout can sustain without
  // dropping frames (the visible "tau-tau done" jump). Frames accumulate
  // into liveRef and flush to state at most once per animation frame.
  const liveRef = useRef<ChatStreamAccumulator | null>(null);
  const rafRef = useRef<number | null>(null);
  const isPinnedToBottomRef = useRef(true);
  const lastScrollTimeRef = useRef(0);

  function studioScroller(): Element | null {
    if (typeof document === "undefined") return null;
    return document.querySelector(".app-main-column");
  }

  function followTranscript(force = false): void {
    const el = studioScroller();
    if (!el) return;
    if (force) {
      isPinnedToBottomRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      return;
    }
    if (!isPinnedToBottomRef.current) return;
    const now = performance.now();
    if (now - lastScrollTimeRef.current < 90) return;
    lastScrollTimeRef.current = now;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }

  function flushLive(): void {
    rafRef.current = null;
    const acc = liveRef.current;
    if (!acc) return;
    setLive({ ...acc, toolCalls: acc.toolCalls.map((call) => ({ ...call })) });
    followTranscript(false);
  }

  function scheduleLiveFlush(): void {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushLive);
  }

  const sessionsQuery = useStudioSessions();
  const detailQuery = useStudioSession(activeId ?? undefined);
  const createSession = useCreateStudioSession();
  const patchSession = usePatchStudioSession();
  const deleteSession = useDeleteStudioSession();
  const studioKey = useStudioKey();
  const catalog = useAllModelsCatalog(true);

  const session: StudioSessionView | undefined = detailQuery.data;
  const summaries = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  // Optimistic user echo layered over the persisted transcript so sends feel
  // instant; it vanishes once the server echo arrives (see the sync effect).
  const canSend = composer.trim().length > 0 || attachments.length > 0;
  const displayed: readonly StudioMessage[] = useMemo(() => {
    const persisted = session?.messages ?? [];
    if (!pendingUser || persisted.some((m) => m.ts === pendingUser.ts)) return persisted;
    return [
      ...persisted,
      {
        role: "user",
        content: pendingUser.content,
        ts: pendingUser.ts,
        ...(pendingUser.attachments === undefined ? {} : { attachments: pendingUser.attachments }),
      },
    ];
  }, [session?.messages, pendingUser]);
  // The dot means "this request differs from provider defaults", not "a box
  // is ticked": temperature always rode along before, so its pre-existing
  // 0.7 still counts as customized only while its switch is on.
  const tuneCustomized =
    (advancedOn && temperatureOn && temperature !== "0.7") ||
    (advancedOn && maxTokensOn && maxTokens.trim().length > 0) ||
    (advancedOn && topPOn && topP.trim().length > 0) ||
    (advancedOn && logprobsOn) ||
    (advancedOn && stripEncryptedReasoning) ||
    systemPrompt.trim().length > 0;

  function resetTune(): void {
    setThink("high");
    setAdvancedOn(false);
    setTemperatureOn(true);
    setTemperature("0.7");
    setMaxTokensOn(false);
    setMaxTokens("");
    setTopPOn(false);
    setTopP("1");
    setLogprobsOn(false);
    setTopLogprobs("5");
    setStripEncryptedReasoning(false);
  }

  useEffect(() => {
    if (session && syncedSessionRef.current !== session.id) {
      syncedSessionRef.current = session.id;
      setModel(session.model);
      setSystemPrompt(session.systemPrompt);
    }
  }, [session]);

  useEffect(() => {
    setPendingUser((pending) => {
      if (!pending || !session) return pending;
      const echoed = session.messages.some(
        (message) =>
          message.role === "user" && message.ts === pending.ts && message.content === pending.content,
      );
      return echoed ? null : pending;
    });
  }, [session]);

  useEffect(() => {
    followTranscript(true);
  }, [displayed.length, pendingUser]);

  useEffect(() => {
    autoresizeComposer();
  }, [composer, attachments.length]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (sessionOpen && sessionRef.current && !sessionRef.current.contains(e.target as Node)) {
        setSessionOpen(false);
        setConfirmDeleteId(null);
      }
      if (tuneOpen && tuneRef.current && !tuneRef.current.contains(e.target as Node)) {
        setTuneOpen(false);
      }
    }
    if (sessionOpen || tuneOpen) {
      document.addEventListener("mousedown", handlePointerDown);
      return () => document.removeEventListener("mousedown", handlePointerDown);
    }
  }, [sessionOpen, tuneOpen]);

  useEffect(() => {
    const el = studioScroller();
    if (!el) return;

    function updateScroll() {
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      const can = max > 80;
      const atBottom = el.scrollTop >= max - 80;
      isPinnedToBottomRef.current = atBottom;
      setScrollState((prev) => {
        if (prev.canScroll !== can || prev.isAtBottom !== atBottom) {
          return { canScroll: can, isAtBottom: atBottom };
        }
        return prev;
      });
    }

    updateScroll();
    el.addEventListener("scroll", updateScroll, { passive: true });
    window.addEventListener("resize", updateScroll);
    return () => {
      el.removeEventListener("scroll", updateScroll);
      window.removeEventListener("resize", updateScroll);
    };
  }, [displayed.length]);

  function toggleScroll(): void {
    const el = studioScroller();
    if (!el) return;
    if (scrollState.isAtBottom) {
      isPinnedToBottomRef.current = false;
      el.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      isPinnedToBottomRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }

  function scrollToMessage(index: number): void {
    const el = document.getElementById(`mlab-msg-${index}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }


  const activeEntry = useMemo(
    () => catalog.items.find((e) => e.qualified === model),
    [catalog.items, model],
  );
  // Permissive when the model isn't in the catalog (alias/combo strings):
  // the route degrades unsupported parts instead of failing the turn.
  const caps = {
    vision: activeEntry?.entry.vision ?? true,
    document: activeEntry?.entry.document ?? true,
    audio: activeEntry?.entry.audio ?? true,
  };
  const unsupportedAttached = attachments.some((a) =>
    a.kind === "image" ? !caps.vision : a.kind === "file" ? !caps.document : !caps.audio,
  );
  const unsupportedKinds = [
    ...(!caps.vision && attachments.some((a) => a.kind === "image") ? ["vision"] : []),
    ...(!caps.document && attachments.some((a) => a.kind === "file") ? ["PDF"] : []),
    ...(!caps.audio && attachments.some((a) => a.kind === "audio") ? ["audio"] : []),
  ].join(" · ");

  async function addFiles(list: ArrayLike<File>): Promise<void> {
    const files = Array.from(list);
    for (const file of files) {
      const kind = kindForMime(file.type);
      if (!kind) {
        toast.error(`Unsupported file: ${file.name || "unnamed"}`);
        continue;
      }
      if (file.size > MAX_ATTACH_BYTES) {
        toast.error(`${file.name} is too large (max ${formatBytes(MAX_ATTACH_BYTES)})`);
        continue;
      }
      try {
        let dataUrl = await readFileAsDataURL(file);
        if (kind === "image") dataUrl = await downscaleImage(dataUrl);
        if (dataUrl.length > 2_000_000) {
          toast.error(`${file.name} is still too large after processing`);
          continue;
        }
        const draft: StudioAttachment = {
          kind,
          name: file.name.slice(0, 200) || "attachment",
          mime: file.type,
          dataUrl,
        };
        setAttachments((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, draft]));
      } catch {
        toast.error(`Could not read ${file.name || "file"}`);
      }
    }
  }

  async function ensureKey(): Promise<string | null> {
    const cached = readStorage(STUDIO_KEY_STORAGE);
    if (cached) return cached;
    try {
      const result = await studioKey.mutateAsync();
      writeSession(STUDIO_KEY_STORAGE, result.key);
      writeSession(STUDIO_PREFIX_STORAGE, result.prefix);
      return result.key;
    } catch (error) {
      toast.error(getErrorMessage(error));
      return null;
    }
  }

  async function ensureSession(): Promise<StudioSessionView | null> {
    if (session) return session;
    try {
      const created = await createSession.mutateAsync({
        title: "New session",
        model,
        systemPrompt,
      });
      syncedSessionRef.current = created.id;
      setActiveId(created.id);
      writeLocal(ACTIVE_KEY, created.id);
      return created;
    } catch (error) {
      toast.error(getErrorMessage(error));
      return null;
    }
  }

  function openPicker(): void {
    setPickerOpen(true);
  }

  async function persistModel(value: string): Promise<void> {
    setModel(value);
    if (session && value !== session.model) {
      try {
        await patchSession.mutateAsync({ sessionId: session.id, model: value });
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    }
  }

  async function persistSystem(value: string): Promise<void> {
    setSystemPrompt(value);
    if (session && value !== session.systemPrompt) {
      try {
        await patchSession.mutateAsync({ sessionId: session.id, systemPrompt: value });
      } catch (error) {
        toast.error(getErrorMessage(error));
      }
    }
  }

  function baseBody(
    targetModel: string,
    messages: Array<Record<string, unknown>>,
    sessionId?: string,
  ): Record<string, unknown> {
    const temperatureValue = Number(temperature);
    const maxTokensValue = maxTokens.trim().length === 0 ? undefined : Number(maxTokens);
    const topPValue = topP.trim().length === 0 ? undefined : Number(topP);
    const topLogprobsValue = topLogprobs.trim().length === 0 ? undefined : Number(topLogprobs);
    return {
      model: targetModel,
      messages,
      ...(sessionId ? { prompt_cache_key: sessionId } : {}),
      // Sampling knobs ride only when the master switch and their own switch
      // are both on; either off means the field is omitted entirely.
      ...(advancedOn && temperatureOn && Number.isFinite(temperatureValue)
        ? { temperature: temperatureValue }
        : {}),
      ...(advancedOn &&
      maxTokensOn &&
      maxTokensValue !== undefined &&
      Number.isFinite(maxTokensValue) &&
      maxTokensValue > 0
        ? { max_tokens: Math.floor(maxTokensValue) }
        : {}),
      ...(advancedOn && topPOn && topPValue !== undefined && Number.isFinite(topPValue) && topPValue > 0 && topPValue <= 1
        ? { top_p: topPValue }
        : {}),
      ...(advancedOn && logprobsOn
        ? {
            logprobs: true,
            ...(topLogprobsValue !== undefined &&
            Number.isInteger(topLogprobsValue) &&
            topLogprobsValue >= 0 &&
            topLogprobsValue <= 20
              ? { top_logprobs: topLogprobsValue }
              : {}),
          }
        : {}),
      ...(think === "auto" ? {} : { reasoning_effort: think }),
      ...(advancedOn && stripEncryptedReasoning ? { omit_encrypted_reasoning: true } : {}),
    };
  }

  async function postChat(
    key: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<Response> {
    return fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(sessionId ? { "x-conversation-id": sessionId, "x-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  /**
   * Streaming-first agentic loop. Tools ride along on every turn, so the
   * model calls them only when useful — no arming UI, no notice when it
   * doesn't. Text streams live; tool calls stream-merge by wire index, then
   * execute locally and continue for up to MAX_TOOL_TURNS turns.
   */
  async function runTurns(
    key: string,
    active: StudioSessionView,
    history: StudioMessage[],
    prompt: string,
    controller: AbortController,
    startedAt: number,
  ): Promise<void> {
    const wire: Array<Record<string, unknown>> = toWireHistory(systemPrompt, history);
    const allowWebTools = webToolsExplicitlyRequested(prompt);
    const availableToolDefs = allowWebTools ? TOOL_DEFS : LOCAL_TOOL_DEFS;
    const displayCalls: Array<{ name: string; args: string; result: string }> = [];
    const toolRounds: Array<{ toolCalls: Array<{ name: string; args: string; result: string }> }> = [];
    let finalText = "";
    let finalReasoning = "";
    let finalUsage: ChatStreamAccumulator["usage"];
    let ttfbMs: number | undefined;
    let turns = 0;
    for (;;) {
      if (stopRef.current || controller.signal.aborted) break;
      if (turns >= MAX_TOOL_TURNS) {
        finalText += `\n\n(tool loop capped at ${MAX_TOOL_TURNS} turns)`;
        break;
      }
      turns += 1;
      const acc = createChatStreamAccumulator();
      const response = await postChat(
        key,
        {
          ...baseBody(model.trim(), wire, active.id),
          stream: true,
          stream_options: { include_usage: true },
          tools: availableToolDefs,
          tool_choice: "auto",
        },
        controller.signal,
        active.id,
      );
      await pumpChatStream(
        response,
        acc,
        {
          onUpdate: (next) => {
            if (ttfbMs === undefined && (next.text.length > 0 || next.reasoning.length > 0))
              ttfbMs = performance.now() - startedAt;
            // Display merges finished turns with the live one; persistence
            // below keeps its own copies, so this object is render-only.
            liveRef.current = {
              text: finalText + next.text,
              reasoning: next.reasoning,
              toolCalls: [],
            };
            scheduleLiveFlush();
          },
        },
        controller.signal,
      );
      finalText += acc.text;
      if (acc.reasoning) finalReasoning += (finalReasoning ? "\n" : "") + acc.reasoning;
      if (acc.usage !== undefined) finalUsage = acc.usage;
      if (acc.finishReason !== "tool_calls" || acc.toolCalls.length === 0) break;
      wire.push({
        role: "assistant",
        content: acc.text.length > 0 ? acc.text : null,
        tool_calls: acc.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name ?? "unknown", arguments: call.args },
        })),
      });
      const roundCalls: Array<{ name: string; args: string; result: string }> = [];
      for (const call of acc.toolCalls) {
        setToolStatus(`running ${call.name ?? "tool"}…`);
        const result = await executeStudioToolAsync(
          call.name ?? "",
          call.args,
          controller.signal,
          allowWebTools,
        );
        const displayCall = { name: call.name ?? "unknown", args: call.args, result };
        displayCalls.push(displayCall);
        roundCalls.push(displayCall);
        wire.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      if (roundCalls.length > 0) toolRounds.push({ toolCalls: roundCalls });
      setToolStatus(null);
    }
    const base: StudioMessage = {
      role: "assistant",
      content: finalText.length > 0 ? finalText : "(no visible output)",
      ts: new Date().toISOString(),
    };
    const withReasoning: StudioMessage =
      finalReasoning.length === 0 ? base : { ...base, reasoning: finalReasoning };
    const withTools: StudioMessage =
      displayCalls.length === 0 ? withReasoning : { ...withReasoning, toolRounds };
    const usage = finalUsage;
    let withUsage: StudioMessage = withTools;
    if (usage !== undefined) {
      const fields: {
        input?: number;
        output?: number;
        reasoning?: number;
        cached?: number;
        total?: number;
      } = {};
      if (usage.input !== undefined) fields.input = usage.input;
      if (usage.output !== undefined) fields.output = usage.output;
      if (usage.reasoning !== undefined) fields.reasoning = usage.reasoning;
      if (usage.cached !== undefined) fields.cached = usage.cached;
      if (usage.total !== undefined) fields.total = usage.total;
      withUsage = { ...withTools, usage: fields };
    }
    const assistantBase: StudioMessage =
      ttfbMs === undefined ? withUsage : { ...withUsage, ttfbMs: Math.round(ttfbMs) };
    const completionMs = Math.round(performance.now() - startedAt);
    const assistant: StudioMessage = { ...assistantBase, completionMs };
    const titlePatch = active.title === "New session" ? { title: autoTitle(prompt) } : {};
    await patchSession.mutateAsync({
      sessionId: active.id,
      messages: [...history, assistant],
      ...titlePatch,
    });
  }

  async function send(preset?: string): Promise<void> {
    const prompt = (preset ?? composer).trim();
    // `sendingRef` is checked (and set) synchronously below; the `sending`
    // state check alone lets rapid double-submits through.
    if ((!prompt && attachments.length === 0) || sending || sendingRef.current) return;
    sendingRef.current = true;
    try {
      const key = await ensureKey();
      if (!key) return;
      const targetModel = model.trim();
      if (!targetModel) {
        toast.error("Pick a model first");
        openPicker();
        return;
      }
      const active = await ensureSession();
      if (!active) return;
      setChatError(null);
      setToolStatus(null);
      setComposer("");
      const outgoing = attachments;
      setAttachments([]);
      requestAnimationFrame(() => {
        followTranscript(true);
      });
      // for the round trip + persistence refetch. It clears the moment the
      // server transcript contains it (see the sync effect below).
      const pending: PendingUser = {
        ts: new Date().toISOString(),
        content: prompt,
        ...(outgoing.length === 0 ? {} : { attachments: outgoing }),
      };
      setPendingUser(pending);
      setSending(true);
      stopRef.current = false;
      const startedAt = performance.now();
      const userMessage: StudioMessage = {
        role: "user",
        content: prompt,
        ts: pending.ts,
        ...(outgoing.length === 0 ? {} : { attachments: outgoing }),
      };
      // Second line of defence: if a prompt already sits at the end of the
      // transcript, reuse it instead of appending another copy. Duplicated
      // user turns make the model answer the same request N times.
      const tail = active.messages[active.messages.length - 1];
      const alreadyQueued =
        tail?.role === "user" && tail.content === prompt && tail.ts === pending.ts;
      const history: StudioMessage[] = alreadyQueued
        ? [...active.messages]
        : [...active.messages, userMessage];
      const controller = new AbortController();
      abortRef.current = controller;
      // Instant feedback: the assistant placeholder (shimmer + typing dots)
      // renders before the first byte arrives.
      liveRef.current = createChatStreamAccumulator();
      setLive(createChatStreamAccumulator());
      try {
        await runTurns(key, active, history, prompt, controller, startedAt);
      } catch (error) {
        if (!controller.signal.aborted && !stopRef.current) setChatError(getErrorMessage(error));
        try {
          await patchSession.mutateAsync({ sessionId: active.id, messages: history });
        } catch {
          /* transcript already visible locally; persistence retries next send */
        }
      } finally {
        abortRef.current = null;
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        liveRef.current = null;
        setLive(null);
        setToolStatus(null);
        setSending(false);
      }
    } finally {
      // Always release the guard, including on the early returns above.
      sendingRef.current = false;
    }
  }

  function stop(): void {
    stopRef.current = true;
    abortRef.current?.abort();
  }

  function selectSession(id: string | null): void {
    setActiveId(id);
    writeLocal(ACTIVE_KEY, id ?? "");
    setConfirmDeleteId(null);
    setSessionOpen(false);
    syncedSessionRef.current = null;
  }

  async function createNew(): Promise<void> {
    if (sending) return;
    try {
      const created = await createSession.mutateAsync({
        title: "New session",
        model,
        systemPrompt,
      });
      syncedSessionRef.current = created.id;
      setActiveId(created.id);
      writeLocal(ACTIVE_KEY, created.id);
      setConfirmDeleteId(null);
      setSessionOpen(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  async function deleteOne(id: string): Promise<void> {
    if (sending) return;
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    try {
      await deleteSession.mutateAsync({ sessionId: id });
      setConfirmDeleteId(null);
      if (id === activeId) {
        const remaining = summaries.filter((s) => s.id !== id);
        const next = remaining[0]?.id ?? null;
        syncedSessionRef.current = next;
        setActiveId(next);
        writeLocal(ACTIVE_KEY, next ?? "");
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }


  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", flex: 1 }}>
      <Card
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
        }}
      >
        <CardBody style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <div
            className="mlab-wide"
            style={{
              maxWidth: "820px",
              width: "100%",
              margin: "0 auto",
              flex: 1,
              display: "flex",
              flexDirection: "column",
            }}
          >
              {displayed.length === 0 && !live ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "40px 16px 24px",
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-head)",
                      fontSize: "30px",
                      fontWeight: 700,
                      letterSpacing: "-0.02em",
                      color: "var(--text-primary)",
                    }}
                  >
                    Model Lab
                  </div>
                  <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginTop: "6px" }}>
                    {model || "Pick a model below"} — answers stream live through your gateway.
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      flexWrap: "wrap",
                      justifyContent: "center",
                      marginTop: "16px",
                    }}
                  >
                    {SUGGESTIONS.map((suggestion) => {
                      const Icon = suggestion.icon;
                      return (
                        <button
                          key={suggestion.label}
                          type="button"
                          onClick={() => void send(suggestion.label)}
                          disabled={sending}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "7px",
                            border: "1px solid var(--inner-border)",
                            borderRadius: "9999px",
                            background: "var(--surface-2)",
                            color: "var(--text-secondary)",
                            fontSize: "11.5px",
                            padding: "7px 14px",
                            cursor: sending ? "default" : "pointer",
                          }}
                        >
                          <Icon size={13} />
                          {suggestion.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "18px",
                    padding: "8px 4px",
                    flex: 1,
                  }}
                >
                  {displayed.map((message, index) => (
                    <div
                      key={`${message.ts}-${index}`}
                      id={`mlab-msg-${index}`}
                      className="mlab-msg-in"
                      style={{ paddingBottom: "6px" }}
                    >
                      {message.role === "user" ? (
                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            justifyContent: "flex-end",
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ maxWidth: "85%" }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                justifyContent: "flex-end",
                                fontSize: "10px",
                                fontWeight: 700,
                                textTransform: "uppercase",
                                letterSpacing: "0.08em",
                                color: "var(--text-tertiary)",
                                marginBottom: "4px",
                              }}
                            >
                              You
                            </div>
                            {message.attachments && message.attachments.length > 0 ? (
                              <div
                                style={{
                                  display: "flex",
                                  gap: "6px",
                                  flexWrap: "wrap",
                                  justifyContent: "flex-end",
                                  marginBottom: message.content ? "6px" : 0,
                                }}
                              >
                                {message.attachments.map((attachment, attachmentIndex) => (
                                  attachment.kind === "image" ? (
                                    <img
                                      key={`${attachment.name}-${attachmentIndex}`}
                                      src={attachment.dataUrl}
                                      alt={attachment.name}
                                      style={{
                                        width: "120px",
                                        height: "120px",
                                        objectFit: "cover",
                                        borderRadius: "12px",
                                        border: "1px solid var(--inner-border)",
                                      }}
                                    />
                                  ) : (
                                    <span
                                      key={`${attachment.name}-${attachmentIndex}`}
                                      style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        background: "var(--surface-muted)",
                                        borderRadius: "12px",
                                        padding: "8px 10px",
                                        fontFamily: "var(--font-mono)",
                                        fontSize: "10.5px",
                                        color: "var(--text-secondary)",
                                        maxWidth: "220px",
                                      }}
                                    >
                                      {attachment.kind === "audio" ? (
                                        <FileAudio size={14} style={{ flexShrink: 0 }} />
                                      ) : (
                                        <FileText size={14} style={{ flexShrink: 0 }} />
                                      )}
                                      <span
                                        style={{
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {attachment.name}
                                      </span>
                                    </span>
                                  )
                                ))}
                              </div>
                            ) : null}
                            {message.content ? (
                              <div
                                style={{
                                  background: "var(--surface-muted)",
                                  borderRadius: "18px",
                                  borderBottomRightRadius: "6px",
                                  padding: "10px 14px",
                                  fontSize: "13.5px",
                                  lineHeight: 1.6,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                {message.content}
                              </div>
                            ) : null}
                          </div>
                          <div style={{ paddingTop: "18px" }}>
                            <Avatar kind="user" />
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                          <Avatar kind="assistant" />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: "11px",
                                fontWeight: 700,
                                letterSpacing: "0.04em",
                                color: "var(--text-secondary)",
                                marginBottom: "4px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {model ? model.split("/").slice(-1)[0] : "assistant"}
                            </div>
                            {message.reasoning ? (
                              <Thinking reasoning={message.reasoning} streaming={false} />
                            ) : null}
                            <ToolChips message={message} />
                            <div style={{ fontSize: "13.5px", lineHeight: 1.65 }}>
                              <Markdown text={message.content} />
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                marginTop: "4px",
                              }}
                            >
                              <MessageMeta message={message} />
                              <CopyButton text={message.content} />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  {live ? (
                    <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                      <Avatar kind="assistant" />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "6px" }}>
                          <div
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              letterSpacing: "0.04em",
                              color: "var(--text-secondary)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {model ? model.split("/").slice(-1)[0] : "assistant"}
                          </div>
                          {sending && !live.text ? (
                            <div
                              style={{
                                display: "inline-flex",
                              alignItems: "center",
                                gap: "6px",
                                fontSize: "11px",
                                fontWeight: 500,
                                color: "var(--text-tertiary)",
                              }}
                            >
                              <span className="mlab-live-dot" />
                              <span className="mlab-thinking-live">Thinking…</span>
                            </div>
                          ) : null}
                        </div>
                        <Thinking reasoning={live.reasoning} streaming={sending} />
                        <div style={{ fontSize: "13.5px", lineHeight: 1.65 }}>
                          {live.text ? (
                            <Markdown text={live.text} />
                          ) : (
                            <span
                              style={{ display: "inline-flex", gap: "4px", padding: "6px 0" }}
                              aria-label="Waiting for response"
                            >
                              <span className="mlab-typing-dot" />
                              <span className="mlab-typing-dot" />
                              <span className="mlab-typing-dot" />
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {toolStatus ? (
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                        fontFamily: "var(--font-mono)",
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                      }}
                    >
                      <span className="mlab-live-dot" /> {toolStatus}
                    </div>
                  ) : null}
                  {chatError ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        flexWrap: "wrap",
                        fontSize: "12px",
                        color: "var(--status-danger)",
                      }}
                    >
                      <span style={{ flex: "1 1 auto" }}>{chatError}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={sending}
                        onClick={() => {
                          const lastUser = [...displayed]
                            .reverse()
                            .find((message) => message.role === "user");
                          if (lastUser) void send(lastUser.content);
                        }}
                      >
                        <RotateCcw size={13} /> Retry
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}

              <div
                className="mlab-composer"
                style={{
                  position: "sticky",
                  bottom: 0,
                  zIndex: 5,
                  width: "min(760px, 100%)",
                  margin: "16px auto 0",
                  background: "transparent",
                  padding: "10px 0 0",
                }}
              >
                {scrollState.canScroll ? (
                  <button
                    type="button"
                    onClick={toggleScroll}
                    aria-label={scrollState.isAtBottom ? "Scroll to top" : "Scroll to bottom"}
                    title={scrollState.isAtBottom ? "Scroll to top" : "Scroll to bottom"}
                    style={{
                      position: "absolute",
                      right: "14px",
                      bottom: "calc(100% + 10px)",
                      zIndex: 10,
                      width: "30px",
                      height: "30px",
                      borderRadius: "9999px",
                      background: "var(--surface-1)",
                      border: "1px solid var(--border-subtle)",
                      boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
                      color: "var(--text-secondary)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      transition: "background-color var(--dur-micro) var(--ease-spring), color var(--dur-micro) var(--ease-spring)",
                    }}
                  >
                    {scrollState.isAtBottom ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                ) : null}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    padding: "16px 20px 14px",
                    background: "var(--surface-1)",
                    borderRadius: "28px",
                    border: "1px solid var(--border-subtle)",
                    boxShadow: "0 12px 36px rgba(0, 0, 0, 0.12)",
                  }}
                >
                <textarea
                  ref={composerRef}
                  value={composer}
                  onChange={(e) => {
                    setComposer(e.target.value);
                    requestAnimationFrame(autoresizeComposer);
                  }}
                  onInput={autoresizeComposer}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  onPaste={(e) => {
                    const files = Array.from(e.clipboardData?.files ?? []);
                    if (files.length > 0) {
                      e.preventDefault();
                      void addFiles(files);
                    }
                  }}
                  placeholder={model ? `Message ${model}…` : "Pick a model, then ask anything…"}
                  rows={1}
                  aria-label="Message"
                  style={{
                    display: "block",
                    width: "100%",
                    minHeight: "24px",
                    maxHeight: "200px",
                    border: "none",
                    background: "transparent",
                    padding: "8px 10px",
                    fontFamily: "inherit",
                    fontSize: "14px",
                    lineHeight: 1.5,
                    resize: "none",
                    outline: "none",
                    overflowY: "hidden",
                    boxSizing: "border-box",
                  }}
                />
                {attachments.length > 0 ? (
                  <div
                    style={{ display: "flex", gap: "6px", flexWrap: "wrap", padding: "6px 4px 2px" }}
                  >
                    {attachments.map((attachment, index) => (
                      <span
                        key={`${attachment.name}-${index}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          border: "1px solid var(--inner-border)",
                          borderRadius: "10px",
                          background: "var(--surface-muted)",
                          padding: "4px 6px 4px 4px",
                          fontSize: "10.5px",
                          color: "var(--text-secondary)",
                          maxWidth: "220px",
                        }}
                      >
                        {attachment.kind === "image" ? (
                          <img
                            src={attachment.dataUrl}
                            alt={attachment.name}
                            style={{
                              width: "28px",
                              height: "28px",
                              objectFit: "cover",
                              borderRadius: "6px",
                            }}
                          />
                        ) : attachment.kind === "audio" ? (
                          <FileAudio size={16} style={{ flexShrink: 0 }} />
                        ) : (
                          <FileText size={16} style={{ flexShrink: 0 }} />
                        )}
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {attachment.name}
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove ${attachment.name}`}
                          onClick={() =>
                            setAttachments((prev) => prev.filter((_, i) => i !== index))
                          }
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "var(--text-tertiary)",
                            padding: "2px",
                            display: "inline-flex",
                          }}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {unsupportedAttached ? (
                  <div style={{ fontSize: "10.5px", color: "var(--status-warning)", padding: "2px 4px" }}>
                    This model lacks {unsupportedKinds} support — flagged files will be stripped
                    by the route instead of failing the turn.
                  </div>
                ) : null}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    marginTop: "4px",
                    width: "100%",
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ACCEPT_STRING}
                    aria-label="Attach image, PDF, or audio"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      void addFiles(e.target.files ?? []);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Attach image, PDF, or audio"
                    title="Attach image, PDF, or audio (or paste)"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "32px",
                      height: "32px",
                      borderRadius: "9999px",
                      border: "1px solid transparent",
                      background: "transparent",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    <Paperclip size={15} />
                  </button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={openPicker}
                    title={model || "Pick model"}
                    style={{
                      maxWidth: "220px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontFamily: "var(--font-mono)",
                      fontSize: "11px",
                      borderRadius: "9999px",
                      border: "1px solid transparent",
                      background: "var(--surface-muted)",
                      padding: "0 12px",
                      height: "28px",
                    }}
                  >
                    {model ? model.split("/").slice(-1)[0] : "Pick model"}
                  </Button>
                  <div style={{ flexShrink: 0 }}>
                    <Select
                      size="sm"
                      style={{
                        width: "auto",
                        minWidth: "76px",
                        borderRadius: "9999px",
                        border: "1px solid transparent",
                        background: "var(--surface-muted)",
                        padding: "0 10px",
                        height: "28px",
                        fontSize: "11px",
                      }}
                      value={think}
                      onValueChange={(value) => {
                        const option = THINK_LEVELS.find((level) => level.value === value);
                        if (option !== undefined) setThink(option.value);
                      }}
                      options={THINK_LEVELS}
                      aria-label="Thinking level"
                    />
                  </div>
                  <div ref={sessionRef} style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setSessionOpen((v) => !v)}
                      aria-expanded={sessionOpen}
                      title="Sessions"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        border: "1px solid transparent",
                        borderRadius: "9999px",
                        background: "var(--surface-muted)",
                        color: "var(--text-secondary)",
                        padding: "0 12px",
                        height: "28px",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                        maxWidth: "180px",
                      }}
                    >
                      <MessageSquareText size={13} />
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {summaries.find((s) => s.id === activeId)?.title ??
                          session?.title ??
                          "Sessions"}
                      </span>
                      <ChevronDown
                        size={11}
                        style={{
                          transform: sessionOpen ? "rotate(180deg)" : undefined,
                          flexShrink: 0,
                        }}
                      />
                    </button>
                    {sessionOpen ? (
                      <div
                        style={{
                          position: "absolute",
                          bottom: "calc(100% + 8px)",
                          left: 0,
                          zIndex: 20,
                          width: "280px",
                          maxHeight: "320px",
                          overflowY: "auto",
                          border: "1px solid var(--inner-border)",
                          borderRadius: "14px",
                          background: "var(--popover-bg)",
                          boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
                          padding: "8px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "2px 4px 8px",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                              color: "var(--text-tertiary)",
                            }}
                          >
                            Sessions
                          </span>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void createNew()}
                            disabled={sending}
                          >
                            <Plus size={12} /> New
                          </Button>
                        </div>
                        {summaries.length === 0 ? (
                          <div style={{ fontSize: "11.5px", color: "var(--text-tertiary)", padding: "4px" }}>
                            {sessionsQuery.isPending ? "Loading…" : "No sessions yet."}
                          </div>
                        ) : (
                          summaries.map((s) => (
                            <div
                              key={s.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "4px",
                                borderRadius: "8px",
                                background: s.id === activeId ? "var(--accent-soft)" : "transparent",
                                padding: "2px",
                              }}
                            >
                              <button
                                type="button"
                                onClick={() => selectSession(s.id)}
                                title={s.title}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  textAlign: "left",
                                  background: "transparent",
                                  border: "none",
                                  cursor: "pointer",
                                  padding: "6px 8px",
                                  borderRadius: "6px",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  fontSize: "12px",
                                  fontWeight: s.id === activeId ? 700 : 400,
                                  color: "var(--text-primary)",
                                }}
                              >
                                {s.title} · {s.messageCount}
                              </button>
                              {confirmDeleteId === s.id ? (
                                <button
                                  type="button"
                                  onClick={() => void deleteOne(s.id)}
                                  style={{
                                    background: "transparent",
                                    border: "none",
                                    cursor: "pointer",
                                    fontSize: "11px",
                                    fontWeight: 700,
                                    color: "var(--status-danger)",
                                    padding: "6px",
                                  }}
                                >
                                  Sure?
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`Delete ${s.title}`}
                                  onClick={() => setConfirmDeleteId(s.id)}
                                  style={{
                                    background: "transparent",
                                    border: "none",
                                    cursor: "pointer",
                                    color: "var(--text-tertiary)",
                                    padding: "6px",
                                    display: "inline-flex",
                                  }}
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
                    <div ref={tuneRef} style={{ position: "relative" }}>
                      <button
                        type="button"
                        onClick={() => setTuneOpen((v) => !v)}
                        aria-expanded={tuneOpen}
                        title="Tune temperature, limits, and system prompt"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "32px",
                          height: "32px",
                          borderRadius: "9999px",
                          border: "1px solid transparent",
                          background: tuneOpen || tuneCustomized ? "var(--accent-soft)" : "var(--surface-muted)",
                          color: tuneCustomized ? "var(--accent)" : "var(--text-secondary)",
                          cursor: "pointer",
                          position: "relative",
                        }}
                      >
                        <SlidersHorizontal size={14} />
                        {tuneCustomized ? (
                          <span
                            aria-hidden="true"
                            style={{
                              position: "absolute",
                              top: "6px",
                              right: "6px",
                              width: "5px",
                              height: "5px",
                              borderRadius: "9999px",
                              background: "var(--status-success)",
                            }}
                          />
                        ) : null}
                      </button>
                      {tuneOpen ? (
                        <div
                          style={{
                            position: "absolute",
                            bottom: "calc(100% + 8px)",
                            right: 0,
                            zIndex: 20,
                            width: "300px",
                            border: "1px solid var(--inner-border)",
                            borderRadius: "16px",
                            background: "var(--popover-bg)",
                            boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
                            padding: "14px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "10px",
                          }}
                        >
                          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <label
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                fontSize: "12px",
                                fontWeight: 600,
                                color: "var(--text-primary)",
                                cursor: "pointer",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={advancedOn}
                                onChange={(e) => setAdvancedOn(e.target.checked)}
                                aria-label="Enable advanced sampling controls"
                              />
                              advanced controls
                            </label>
                            <span style={{ fontSize: "11px", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                              Master switch for sampling knobs. Off = temperature, max tokens, top-p,
                              logprobs, and drop-reasoning are all omitted from the request.
                            </span>
                          </div>
                          {advancedOn ? (
                            <>
                              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                  <input
                                    type="checkbox"
                                    checked={temperatureOn}
                                    onChange={(e) => setTemperatureOn(e.target.checked)}
                                    aria-label="Send temperature"
                                  />
                                  <Input
                                    value={temperature}
                                    onChange={(e) => setTemperature(e.target.value)}
                                    placeholder="temp"
                                    aria-label="Temperature"
                                    disabled={!temperatureOn}
                                    style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}
                                  />
                                  <input
                                    type="checkbox"
                                    checked={maxTokensOn}
                                    onChange={(e) => setMaxTokensOn(e.target.checked)}
                                    aria-label="Send max tokens"
                                  />
                                  <Input
                                    value={maxTokens}
                                    onChange={(e) => setMaxTokens(e.target.value)}
                                    placeholder="max toks"
                                    aria-label="Max tokens"
                                    disabled={!maxTokensOn}
                                    style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}
                                  />
                                </div>
                                <span style={{ fontSize: "11px", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                  Tick to send. Unticked fields are omitted, never zeroed. Temperature
                                  defaults on at 0.7; max tokens defaults off (uncapped).
                                </span>
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                                  <input
                                    type="checkbox"
                                    checked={topPOn}
                                    onChange={(e) => setTopPOn(e.target.checked)}
                                    aria-label="Send top P"
                                  />
                                  <Input
                                    value={topP}
                                    onChange={(e) => setTopP(e.target.value)}
                                    placeholder="top-p (0-1)"
                                    aria-label="Top P"
                                    disabled={!topPOn}
                                    style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}
                                  />
                                  <input
                                    type="checkbox"
                                    checked={logprobsOn}
                                    onChange={(e) => setLogprobsOn(e.target.checked)}
                                    aria-label="Return token logprobs"
                                  />
                                  <Input
                                    value={topLogprobs}
                                    onChange={(e) => setTopLogprobs(e.target.value)}
                                    placeholder="top logprobs (0-20)"
                                    aria-label="Top logprobs"
                                    disabled={!logprobsOn}
                                    style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}
                                  />
                                </div>
                                <span style={{ fontSize: "11px", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                  Top-p (nucleus sampling, 0–1, lower = more focused) and token
                                  logprobs (top-N alternatives per token, 0–20).
                                </span>
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <label
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "8px",
                                    fontSize: "12px",
                                    color: "var(--text-secondary)",
                                    cursor: "pointer",
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={stripEncryptedReasoning}
                                    onChange={(e) => setStripEncryptedReasoning(e.target.checked)}
                                    aria-label="Drop encrypted reasoning before dispatch"
                                  />
                                  drop encrypted reasoning
                                </label>
                                <span style={{ fontSize: "11px", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                                  Strips opaque encrypted reasoning artifacts before dispatch so
                                  they are never emitted upstream. Summaries and visible thinking
                                  are untouched; the strip is reported, never silent.
                                </span>
                              </div>
                            </>
                          ) : null}
                          <Textarea
                            value={systemPrompt}
                            onChange={(e) => setSystemPrompt(e.target.value)}
                            onBlur={(e) => void persistSystem(e.target.value)}
                            placeholder="Optional system instructions, injected ahead of every turn…"
                            rows={3}
                            aria-label="System prompt"
                            style={{ fontSize: "12px" }}
                          />
                          <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <Button variant="ghost" size="sm" onClick={resetTune}>
                              Reset defaults
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    {sending ? (
                      <button
                        type="button"
                        onClick={stop}
                        aria-label="Stop generating"
                        title="Stop"
                        className="mlab-send-btn"
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "9999px",
                          border: "none",
                          background: "var(--status-danger)",
                          color: "#fff",
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Square size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void send()}
                        disabled={!canSend}
                        aria-label="Send message"
                        title="Send"
                        className="mlab-send-btn"
                        style={{
                          width: "32px",
                          height: "32px",
                          borderRadius: "9999px",
                          border: "none",
                          background: !canSend ? "var(--surface-muted)" : "var(--accent)",
                          color: !canSend ? "var(--text-tertiary)" : "var(--accent-foreground)",
                          cursor: !canSend ? "default" : "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Send size={14} />
                      </button>
                    )}
                  </div>
                </div>
                </div>
              </div>

            </div>
        </CardBody>
      </Card>
      <ChatTimeline messages={displayed} model={model} onScrollTo={scrollToMessage} />
      <ModelPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={[]}
        onToggle={() => {}}
        multi={false}
        title="Select chat model"
        onSelectOne={(qualified) => void persistModel(qualified)}
      />
    </div>
  );
}
