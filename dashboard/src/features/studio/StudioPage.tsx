import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody } from "../../components/ui/card";
import { Dialog } from "../../components/ui/dialog";

import { useApiKeys, useRevealApiKey } from "../../hooks/api-keys";
import { ChatBubble } from "./ChatBubble";
import { Composer } from "./Composer";
import { buildLabRequest, type LabEffort, type LabImage } from "./protocol";
import { EMPTY_DRAFT, deleteLabSession, listLabSessions, newLabSession, nextMessageId, readActiveSessionId, readLabDraft, readLabSession, writeActiveSessionId, writeLabSession, type LabDraft, type LabMessage, type LabSession, type LabSessionSummary } from "./session";
import { SettingsDrawer } from "./SettingsDrawer";
import { readLabStream } from "./stream";



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
    const outgoingImages = override?.images ?? images;
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
    const paint = (next: { text: string; reasoning: string; status: string; pending?: boolean; usage?: LabMessage["usage"]; error?: boolean }) => {
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
      });
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
      const startedAt = performance.now();
      let firstTokenAt: number | undefined;
      let usage: LabMessage["usage"] = {};
      let status = "streaming";
      await readLabStream(
        response,
        draft.protocol,
        (delta) => {
          if (firstTokenAt === undefined) firstTokenAt = performance.now();
          accumulated += delta;
          paint({ text: accumulated, reasoning, status, pending: true, usage });
        },
        (thought) => {
          reasoning += thought;
          paint({ text: accumulated, reasoning, status, pending: true, usage });
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
        controller.signal,
      );
      const finishedAt = performance.now();
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

  const canSend = (input.trim().length > 0 || images.length > 0) && !sending && draft.model.length > 0 && (keys.data ?? []).some((key) => key.enabled && key.revokedAt === undefined && key.isDefault);

  return (
    <Card className="mlab-page">
      <CardBody className="mlab-body">
        <div
          ref={scrollerRef}
          className="mlab-scroll"
          onScroll={(event) => {
            const node = event.currentTarget;
            stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}
        >
          {draft.messages.length === 0 ? (
            <div className="mlab-empty">
              <p>Pick a model, then send a message.</p>
            </div>
          ) : (
            <div className="mlab-thread">
              {draft.messages.map((message, index) => (
                <ChatBubble
                  key={message.id}
                  message={message}
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
        <div className="mlab-dock">
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
      </CardBody>
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        draft={draft}
        onChange={patch}
      />
      <Dialog open={sessionsOpen} onClose={() => setSessionsOpen(false)} title="Chat sessions">
        <div className="mlab-sessions">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              const created = newLabSession({ ...EMPTY_DRAFT, model: draft.model, protocol: draft.protocol, mode: draft.mode, effort: draft.effort });
              setSession(created);
              setInput("");
              setImages([]);
              setSessionsOpen(false);
            }}
          >
            New chat
          </Button>
          {sessions.length === 0 ? <p>No chats yet.</p> : sessions.map((item) => (
            <div key={item.id} className={item.id === session.id ? "mlab-session mlab-session-active" : "mlab-session"}>
              <button
                type="button"
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
