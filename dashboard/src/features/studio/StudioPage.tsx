import { Code2, Languages, Lightbulb, MessageCircle, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";

import { useApiKeys, useRevealApiKey } from "../../hooks/api-keys";
import { ChatBubble } from "./ChatBubble";
import { Composer } from "./Composer";
import { buildLabRequest, MODEL_LAB_PRESETS, type LabEffort, type LabImage } from "./protocol";
import { EMPTY_DRAFT, deleteLabSession, listLabSessions, newLabSession, nextMessageId, readActiveSessionId, readLabDraft, readLabSession, writeActiveSessionId, writeLabSession, type LabDraft, type LabMessage, type LabSession, type LabSessionSummary } from "./session";
import { SettingsDrawer } from "./SettingsDrawer";
import { readLabStream } from "./stream";

const STARTER_ICONS: Readonly<Record<string, LucideIcon>> = {
  Explain: Lightbulb,
  Hello: MessageCircle,
  Translate: Languages,
  Code: Code2,
};



/**
 * Model Lab.
 *
 * The page itself does not scroll. The transcript is the only scroller, so a
 * wheel at the end of the bubbles stops there instead of dragging the console
 * page. The composer stays docked under the bubbles.
 */
export function StudioPage(): ReactNode {
  const [session, setSession] = useState<LabSession>(() => newLabSession());
  const [sessions, setSessions] = useState<readonly LabSessionSummary[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<readonly LabImage[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const keys = useApiKeys();
  const reveal = useRevealApiKey();
  const draft = session;
  const setDraft = (next: LabDraft | ((current: LabDraft) => LabDraft)) => {
    setSession((current) => {
      const resolved = typeof next === "function" ? next(current) : { ...current, ...next };
      return { ...current, ...resolved, title: current.title, updatedAt: Date.now() };
    });
  };

  const refreshSessions = async () => {
    setSessions(await listLabSessions());
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = readActiveSessionId(window.sessionStorage);
      const existing = active.length > 0 ? await readLabSession(active) : null;
      const legacy = readLabDraft(window.sessionStorage);
      const opened = existing ?? newLabSession(legacy.messages.length > 0 ? legacy : EMPTY_DRAFT);
      if (cancelled) return;
      setSession(opened);
      writeActiveSessionId(window.sessionStorage, opened.id);
      await writeLabSession(opened);
      if (!cancelled) setSessions(await listLabSessions());
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeActiveSessionId(window.sessionStorage, session.id);
    const handle = window.setTimeout(() => {
      void writeLabSession(session).then(() => refreshSessions());
    }, 250);
    return () => window.clearTimeout(handle);
  }, [session, hydrated]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node === null || !stickRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [draft.messages, sending]);

  const patch = (next: Partial<LabDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const replaceMessage = (id: string, next: LabMessage) => {
    setDraft((current) => ({
      ...current,
      messages: current.messages.map((message) => (message.id === id ? next : message)),
    }));
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const send = async (override?: { readonly text: string; readonly history: readonly LabMessage[]; readonly images?: readonly LabImage[] }) => {
    const text = (override?.text ?? input).trim();
    const outgoingImages = override === undefined ? images : override.images ?? [];
    const defaultKey = (keys.data ?? []).find((key) => key.enabled && key.revokedAt === undefined && key.isDefault);
    if ((text.length === 0 && outgoingImages.length === 0) || sending || draft.model.length === 0 || defaultKey === undefined) return;
    const user: LabMessage = override === undefined
      ? {
          id: nextMessageId(),
          role: "user",
          text,
          model: draft.model,
          ...(outgoingImages.length > 0 ? { images: outgoingImages } : {}),
        }
      : override.history[override.history.length - 1] ?? {
          id: nextMessageId(),
          role: "user",
          text,
          model: draft.model,
        };
    const assistantId = nextMessageId();
    const assistant: LabMessage = {
      id: assistantId,
      role: "assistant",
      text: "",
      model: draft.model,
      status: "streaming",
      pending: true,
    };
    const history = override?.history ?? [...draft.messages, user];
    if (override === undefined) {
      setInput("");
      setImages([]);
    }
    stickRef.current = true;
    setSending(true);
    setDraft((current) => ({ ...current, messages: [...history, assistant] }));

    const controller = new AbortController();
    abortRef.current = controller;
    const tools = new Set<string>();
    const paint = (next: { text: string; reasoning: string; status: string; pending?: boolean; usage?: LabMessage["usage"]; error?: boolean; tools?: readonly string[] }) => {
      replaceMessage(assistantId, {
        id: assistantId,
        role: "assistant",
        text: next.text,
        model: draft.model,
        status: next.status,
        ...(next.reasoning.length > 0 ? { reasoning: next.reasoning } : {}),
        ...(next.usage === undefined ? {} : { usage: next.usage }),
        ...(next.pending === true ? { pending: true } : {}),
        ...(next.error === true ? { error: true } : {}),
        ...(next.tools !== undefined && next.tools.length > 0 ? { tools: next.tools } : {}),
      });
    };
    let queuedPaint: Parameters<typeof paint>[0] | undefined;
    let paintFrame: number | undefined;
    const schedulePaint = (next: Parameters<typeof paint>[0]) => {
      queuedPaint = next;
      if (paintFrame !== undefined) return;
      paintFrame = requestAnimationFrame(() => {
        paintFrame = undefined;
        const latest = queuedPaint;
        queuedPaint = undefined;
        if (latest !== undefined) paint(latest);
      });
    };
    const flushPaint = () => {
      if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
      paintFrame = undefined;
      const latest = queuedPaint;
      queuedPaint = undefined;
      if (latest !== undefined) paint(latest);
    };
    try {
      const revealed = await reveal.mutateAsync({ keyId: defaultKey.id });
      const built = buildLabRequest(
        history.map((message) => ({
          role: message.role,
          text: message.text,
          ...(message.images === undefined ? {} : { images: message.images }),
        })),
        draft,
      );
      const startedAt = performance.now();
      const response = await fetch(built.path, {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          Authorization: `Bearer ${revealed.secret}`,
        },
        body: JSON.stringify(built.body),
      });
      let accumulated = "";
      let reasoning = "";
      let firstTokenAt: number | undefined;
      let usage: LabMessage["usage"] = {};
      let status = "streaming";
      const markFirstToken = () => {
        if (firstTokenAt === undefined) firstTokenAt = performance.now();
      };
      await readLabStream(
        response,
        draft.protocol,
        (delta) => {
          markFirstToken();
          accumulated += delta;
          schedulePaint({ text: accumulated, reasoning, status, pending: true, usage });
        },
        (thought) => {
          markFirstToken();
          reasoning += thought;
          schedulePaint({ text: accumulated, reasoning, status, pending: true, usage });
        },
        (next) => {
          usage = {
            ...usage,
            ...(next.inputTokens === undefined ? {} : { inputTokens: next.inputTokens }),
            ...(next.cachedTokens === undefined ? {} : { cachedTokens: next.cachedTokens }),
            ...(next.outputTokens === undefined ? {} : { outputTokens: next.outputTokens }),
          };
          if (next.status !== undefined) status = next.status;

        },
        (tool) => {
          tools.add(tool);
          schedulePaint({ text: accumulated, reasoning, status, pending: true, usage, tools: [...tools] });
        },
        controller.signal,
      );
      const finishedAt = performance.now();
      flushPaint();
      paint({
        text: accumulated.length > 0 ? accumulated : "No text came back.",
        reasoning,
        status: status === "streaming" ? "completed" : status,
        usage: {
          ...usage,
          ...(firstTokenAt === undefined ? {} : { ttftMs: Math.round(firstTokenAt - startedAt) }),
          completionMs: Math.round(finishedAt - startedAt),
        },
      });
    } catch (error) {
      const stopped = controller.signal.aborted;
      flushPaint();
      paint({
        text: stopped ? "Stopped." : error instanceof Error ? error.message : "Request failed",
        reasoning: "",
        status: stopped ? "stopped" : "error",
        ...(stopped ? {} : { error: true }),
      });
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  const hasDefaultKey = (keys.data ?? []).some((key) => key.enabled && key.revokedAt === undefined && key.isDefault);
  const canSend = (input.trim().length > 0 || images.length > 0) && !sending && draft.model.length > 0 && hasDefaultKey;
  const canSendStarter = !sending && draft.model.length > 0 && hasDefaultKey;
  const sendStarter = (text: string) => {
    if (!canSendStarter) return;
    const user: LabMessage = {
      id: nextMessageId(),
      role: "user",
      text,
      model: draft.model,
    };
    setInput("");
    setImages([]);
    void send({ text, history: [...draft.messages, user], images: [] });
  };

  return (
    <Card className="flex-auto min-h-0 h-route max-h-route flex flex-col overflow-hidden overscroll-none">
      <CardBody className="flex-auto min-h-0 p-0 gap-0">
        <div className="flex flex-auto min-h-0 min-w-0 flex-row max-medium:flex-col">
        <div className="flex-auto min-w-0 min-h-0 flex flex-col">
          <div
          ref={scrollerRef}
          className="scroll-region flex-auto min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain flex flex-col"
          onScroll={(event) => {
            const node = event.currentTarget;
            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}
        >
          {draft.messages.length === 0 ? (
            <div className="flex-auto flex flex-col items-center justify-center gap-4 px-8 py-12 text-center text-text-tertiary text-body leading-normal [&_p]:m-0">
              <p className="text-text-primary text-title font-semibold">Model Lab</p>
              <p>Pick a model, then try a starter.</p>
              <div className="flex flex-wrap justify-center gap-4 mt-4">
                {MODEL_LAB_PRESETS.map((preset) => {
                  const Icon = STARTER_ICONS[preset.label] ?? MessageCircle;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      className="h-15 px-6 inline-flex items-center gap-3 border border-border-strong rounded-pill bg-surface-1 text-text-secondary text-caption cursor-pointer transition-[border-color,background-color,color] duration-150 ease-spring hover:border-accent hover:bg-active-pill hover:text-text-primary disabled:opacity-40 disabled:cursor-default"
                      disabled={!canSendStarter}
                      onClick={() => sendStarter(preset.prompt)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="w-full max-w-380 mx-auto px-8 py-9 pb-6 flex flex-col gap-5">
              {draft.messages.map((message, index) => (
                <ChatBubble
                  key={message.id}
                  message={message}
                  onRetry={
                    message.role === "user" &&
                    draft.messages[index + 1]?.role === "assistant" &&
                    draft.messages[index + 1]?.error === true
                      ? () => {
                          const history = draft.messages.slice(0, index + 1);
                          void send({
                            text: message.text,
                            history,
                            ...(message.images === undefined ? {} : { images: message.images }),
                          });
                        }
                      : undefined
                  }
                  retryDisabled={sending || !hasDefaultKey || draft.model.length === 0}
                  onEdit={message.role === "user" ? (text) => {
                    const next = { ...message, text };
                    const history = [...draft.messages.slice(0, index), next];
                    setDraft((current) => ({ ...current, messages: history }));
                    void send({ text, history, ...(message.images === undefined ? {} : { images: message.images }) });
                  } : undefined}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex-none w-full max-w-380 mx-auto px-6 pb-2">
          <Composer
            model={draft.model}
            sessionTitle={session.title}
            onOpenSessions={() => setSessionsOpen(true)}

            onModel={(model) => patch({ model })}
            value={input}
            onChange={setInput}
            images={images}
            onImages={setImages}
            effort={draft.effort}
            onEffort={(effort: LabEffort) => patch({ effort })}
            sending={sending}
            canSend={canSend}
            onSend={() => void send()}
            onStop={stop}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
        </div>
        <SettingsDrawer
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          draft={draft}
          onChange={patch}
        />
              </div>
      </CardBody>
      <Dialog open={sessionsOpen} onClose={() => setSessionsOpen(false)} title="Chat sessions">
        <div className="flex flex-col gap-3 max-h-180 overflow-auto">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              const created = newLabSession({ ...EMPTY_DRAFT, model: draft.model, protocol: draft.protocol, effort: draft.effort });
              setSession(created);
              setInput("");
              setImages([]);
              setSessionsOpen(false);
            }}
          >
            New chat
          </Button>
          {sessions.length === 0 ? <p>No chats yet.</p> : sessions.map((item) => (
            <div key={item.id} className={item.id === session.id ? "flex items-center gap-4 rounded-control p-2 bg-accent-soft" : "flex items-center gap-4 rounded-control p-2"}>
              <button
                type="button"
                className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left border-0 bg-transparent text-text-primary text-body px-4 py-3 cursor-pointer"
                onClick={() => {
                  void readLabSession(item.id).then((loaded) => {
                    if (loaded === null) return;
                    setSession(loaded);
                    setSessionsOpen(false);
                  });
                }}
              >
                {item.title}
              </button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => {
                  void deleteLabSession(item.id).then(async () => {
                    if (item.id === session.id) setSession(newLabSession({ ...EMPTY_DRAFT, model: draft.model }));
                    setSessions(await listLabSessions());
                  });
                }}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      </Dialog>
    </Card>
  );

}

export default StudioPage;
