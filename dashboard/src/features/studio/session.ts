/**
 * Model Lab keeps every conversation in IndexedDB. Session storage only
 * remembers which one is open, so a reload comes back to it and a new chat
 * does not wipe the others.
 */

import type { LabEffort, LabImage, LabMode, LabProtocol } from "./protocol";

export interface LabUsage {
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly ttftMs?: number;
  readonly completionMs?: number;
}

export interface LabMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly images?: readonly LabImage[];
  readonly model?: string;
  readonly reasoning?: string;
  readonly status?: string;
  readonly usage?: LabUsage;
  readonly pending?: boolean;
  readonly error?: boolean;
}

export interface LabDraft {
  readonly model: string;
  readonly protocol: LabProtocol;
  readonly mode: LabMode;
  readonly systemPrompt: string;
  readonly temperature: string;
  readonly topP: string;
  readonly effort: LabEffort;
  readonly messages: readonly LabMessage[];

}

export const EMPTY_DRAFT: LabDraft = {
  model: "",
  protocol: "chat",
  mode: "agentic",
  systemPrompt: "",
  temperature: "",
  topP: "",
  effort: "high",
  messages: [],

};

const ACTIVE_KEY = "cartethyia.model-lab.active";
const LEGACY_KEY = "cartethyia.model-lab.v1";
const DB_NAME = "cartethyia.model-lab";
const DB_VERSION = 1;
const STORE = "sessions";

export interface LabSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

export interface LabSession extends LabDraft {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open Model Lab sessions."));
  return promise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Model Lab session store rejected the request."));
  return promise;
}

function done(tx: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("Model Lab session store failed."));
  return promise;
}

const SESSION_NAMES = ["amber", "birch", "cedar", "coral", "daisy", "ember", "flint", "frost", "hazel", "ivory", "jade", "maple", "moss", "olive", "pearl", "quartz", "reed", "sage", "slate", "willow"] as const;

export function sessionName(): string {
  const word = SESSION_NAMES[Math.floor(Math.random() * SESSION_NAMES.length)] ?? "chat";
  const stamp = Math.floor(Math.random() * 90 + 10).toString();
  return `${word}${stamp}`.slice(0, 8);
}

export function newLabSession(draft: LabDraft = EMPTY_DRAFT): LabSession {
  return { ...draft, id: nextMessageId(), title: sessionName(), updatedAt: Date.now() };
}

export async function listLabSessions(): Promise<readonly LabSessionSummary[]> {
  const db = await openDb();
  const rows = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  db.close();
  return (rows as LabSession[])
    .map((row) => ({ id: row.id, title: (row.title || "chat").slice(0, 8), updatedAt: row.updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function readLabSession(id: string): Promise<LabSession | null> {
  const db = await openDb();
  const row = await requestToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
  db.close();
  if (row === undefined || row === null || typeof row !== "object") return null;
  const record = row as LabSession;
  return { ...EMPTY_DRAFT, ...record, effort: isEffort(record.effort) ? record.effort : "high", messages: readMessages(record.messages), title: (record.title || sessionName()).slice(0, 8) };
}

export async function writeLabSession(session: LabSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({ ...session, title: session.title || sessionName(), updatedAt: Date.now() });
  await done(tx);
  db.close();
}

export async function deleteLabSession(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(id);
  await done(tx);
  db.close();
}

export function readActiveSessionId(storage: Storage | undefined): string {
  if (storage === undefined) return "";
  return storage.getItem(ACTIVE_KEY) ?? "";
}

export function writeActiveSessionId(storage: Storage | undefined, id: string): void {
  if (storage === undefined) return;
  storage.setItem(ACTIVE_KEY, id);
}


function isProtocol(value: unknown): value is LabProtocol {
  return value === "chat" || value === "responses" || value === "messages";
}

function isMode(value: unknown): value is LabMode {
  return value === "agentic" || value === "media";
}

function isEffort(value: unknown): value is LabEffort {
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "max";
}

function readImages(value: unknown): readonly LabImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images = value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.dataUrl !== "string") return [];
    if (!record.dataUrl.startsWith("data:image/")) return [];
    return [{ name: record.name, dataUrl: record.dataUrl }];
  });
  return images.length > 0 ? images : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): LabUsage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usage: LabUsage = {
    ...(readNumber(record.inputTokens) === undefined ? {} : { inputTokens: readNumber(record.inputTokens) }),
    ...(readNumber(record.cachedTokens) === undefined ? {} : { cachedTokens: readNumber(record.cachedTokens) }),
    ...(readNumber(record.outputTokens) === undefined ? {} : { outputTokens: readNumber(record.outputTokens) }),
    ...(readNumber(record.reasoningTokens) === undefined ? {} : { reasoningTokens: readNumber(record.reasoningTokens) }),
    ...(readNumber(record.ttftMs) === undefined ? {} : { ttftMs: readNumber(record.ttftMs) }),
    ...(readNumber(record.completionMs) === undefined ? {} : { completionMs: readNumber(record.completionMs) }),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function readMessages(value: unknown): readonly LabMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: LabMessage[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") continue;
    if (typeof record.id !== "string" || typeof record.text !== "string") continue;
    const images = readImages(record.images);
    const usage = readUsage(record.usage);
    messages.push({
      id: record.id,
      role: record.role,
      text: record.text,
      ...(images === undefined ? {} : { images }),
      ...(typeof record.model === "string" && record.model.length > 0 ? { model: record.model } : {}),
      ...(typeof record.reasoning === "string" && record.reasoning.length > 0 ? { reasoning: record.reasoning } : {}),
      ...(typeof record.status === "string" && record.status.length > 0 ? { status: record.status } : {}),
      ...(usage === undefined ? {} : { usage }),
      ...(record.error === true ? { error: true } : {}),
    });
  }
  return messages;
}

export function readLabDraft(storage: Storage | undefined): LabDraft {
  if (storage === undefined) return EMPTY_DRAFT;
  try {
    const raw = storage.getItem(LEGACY_KEY);
    if (raw === null) return EMPTY_DRAFT;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return EMPTY_DRAFT;
    const record = parsed as Record<string, unknown>;
    return {
      model: typeof record.model === "string" ? record.model : "",
      protocol: isProtocol(record.protocol) ? record.protocol : "chat",
      mode: isMode(record.mode) ? record.mode : "agentic",
      systemPrompt: typeof record.systemPrompt === "string" ? record.systemPrompt : "",
      temperature: typeof record.temperature === "string" ? record.temperature : "",
      topP: typeof record.topP === "string" ? record.topP : "",
      effort: isEffort(record.effort) ? record.effort : "high",
      messages: readMessages(record.messages),

    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function writeLabDraft(storage: Storage | undefined, draft: LabDraft): void {
  if (storage === undefined) return;
  try {
    storage.setItem(LEGACY_KEY, JSON.stringify(draft));
  } catch {
    // A full or blocked store must not break the conversation on screen.
  }
}

export function nextMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
