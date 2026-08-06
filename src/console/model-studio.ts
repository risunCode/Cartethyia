import { runtimeMemoryLimits } from "../traffic/limits";

export type StudioRole = "system" | "user" | "assistant";

export interface StudioUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
  readonly source: "provider" | "estimated";
}

export interface StudioMessage {
  readonly role: StudioRole;
  readonly content: string;
  readonly ts: string;
  readonly reasoning?: string;
  readonly usage?: StudioUsage;
  readonly images?: string[];
}

export interface StudioSession {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly StudioMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StudioSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const sessions = new Map<string, StudioSession>();
const sessionBytes = new Map<string, number>();
let totalSessionBytes = 0;
const encoder = new TextEncoder();
const MAX_STUDIO_MESSAGES = 200;
const MAX_TITLE_CHARS = 200;
const MAX_MODEL_CHARS = 200;
const MAX_SYSTEM_PROMPT_CHARS = 32_000;
const MAX_MESSAGE_CONTENT_CHARS = 128_000;
const MAX_MESSAGE_REASONING_CHARS = 128_000;
const MAX_MESSAGE_IMAGES = 4;
const MAX_MESSAGE_IMAGE_CHARS = 256_000;

function now(): string {
  return new Date().toISOString();
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedText(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function isStudioMessage(value: unknown): value is StudioMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (message.role === "system" || message.role === "user" || message.role === "assistant") && typeof message.content === "string" && typeof message.ts === "string";
}

function boundStudioMessage(message: StudioMessage): StudioMessage {
  const images = Array.isArray(message.images)
    ? message.images.filter((image): image is string => typeof image === "string" && image.length <= MAX_MESSAGE_IMAGE_CHARS).slice(-MAX_MESSAGE_IMAGES)
    : undefined;
  return {
    role: message.role,
    content: boundedText(message.content, MAX_MESSAGE_CONTENT_CHARS),
    ts: boundedText(message.ts, 64),
    ...(message.reasoning === undefined ? {} : { reasoning: boundedText(message.reasoning, MAX_MESSAGE_REASONING_CHARS) }),
    ...(images === undefined ? {} : { images }),
  };
}

/** Normalizes persisted message metadata and rejects malformed entries. */
export function normalizeStudioMessages(value: unknown): StudioMessage[] | null {
  if (!Array.isArray(value) || !value.every(isStudioMessage)) return null;
  return value.slice(-MAX_STUDIO_MESSAGES).map(boundStudioMessage);
}

function measureSession(session: StudioSession): number {
  let bytes = utf8Bytes(session.id) + utf8Bytes(session.title) + utf8Bytes(session.model) + utf8Bytes(session.systemPrompt) + utf8Bytes(session.createdAt) + utf8Bytes(session.updatedAt);
  for (const message of session.messages) {
    bytes += utf8Bytes(message.role) + utf8Bytes(message.content) + utf8Bytes(message.ts);
    if (message.reasoning !== undefined) bytes += utf8Bytes(message.reasoning);
    for (const image of message.images ?? []) bytes += utf8Bytes(image);
  }
  return bytes;
}

function removeSession(id: string): void {
  const bytes = sessionBytes.get(id) ?? 0;
  sessions.delete(id);
  sessionBytes.delete(id);
  totalSessionBytes = Math.max(0, totalSessionBytes - bytes);
}

function evictExpired(): void {
  const cutoff = Date.now() - runtimeMemoryLimits.studioTtlMs;
  for (const [id, session] of sessions) {
    if (Date.parse(session.updatedAt) < cutoff) removeSession(id);
  }
}

function oldestSessionId(exclude: string | null): string | null {
  let oldest: { id: string; updatedAt: string } | null = null;
  for (const session of sessions.values()) {
    if (session.id === exclude) continue;
    if (oldest === null || session.updatedAt < oldest.updatedAt) oldest = { id: session.id, updatedAt: session.updatedAt };
  }
  return oldest?.id ?? null;
}

function storeSession(session: StudioSession): boolean {
  const bytes = measureSession(session);
  if (bytes > runtimeMemoryLimits.studioMaxSessionBytes) return false;
  evictExpired();
  if (sessions.has(session.id)) removeSession(session.id);
  while (sessions.size >= runtimeMemoryLimits.studioMaxSessions || totalSessionBytes + bytes > runtimeMemoryLimits.studioMaxTotalBytes) {
    const oldest = oldestSessionId(session.id);
    if (oldest === null) return false;
    removeSession(oldest);
  }
  sessions.set(session.id, session);
  sessionBytes.set(session.id, bytes);
  totalSessionBytes += bytes;
  return true;
}

function summary(session: StudioSession): StudioSessionSummary {
  return { id: session.id, title: session.title, model: session.model, messageCount: session.messages.length, createdAt: session.createdAt, updatedAt: session.updatedAt };
}

/** Lists ephemeral Model Studio sessions for the authenticated console. */
export function listStudioSessions(): StudioSessionSummary[] {
  evictExpired();
  return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(summary);
}

/** Reads one ephemeral Model Studio session. */
export function getStudioSession(id: string): StudioSession | null {
  evictExpired();
  return sessions.get(id) ?? null;
}

/** Creates a Model Studio session without contacting a provider. */
export function createStudioSession(input: { title?: string; model?: string; systemPrompt?: string }): StudioSession {
  const timestamp = now();
  const session: StudioSession = {
    id: crypto.randomUUID(),
    title: boundedText(input.title?.trim() || "New session", MAX_TITLE_CHARS),
    model: boundedText(input.model?.trim() || "", MAX_MODEL_CHARS),
    systemPrompt: boundedText(input.systemPrompt ?? "", MAX_SYSTEM_PROMPT_CHARS),
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!storeSession(session)) throw new Error("Model Studio session memory limit reached");
  return session;
}

/** Updates session metadata and bounded message metadata from the Dashboard. */
export function patchStudioSession(id: string, input: { title?: string; model?: string; systemPrompt?: string; messages?: StudioMessage[] }): StudioSession | null {
  evictExpired();
  const existing = sessions.get(id);
  if (existing === undefined) return null;
  const updated: StudioSession = {
    ...existing,
    title: boundedText(input.title?.trim() || existing.title, MAX_TITLE_CHARS),
    model: boundedText(input.model?.trim() ?? existing.model, MAX_MODEL_CHARS),
    systemPrompt: boundedText(input.systemPrompt ?? existing.systemPrompt, MAX_SYSTEM_PROMPT_CHARS),
    messages: input.messages === undefined ? existing.messages : input.messages.slice(-MAX_STUDIO_MESSAGES).map(boundStudioMessage),
    updatedAt: now(),
  };
  if (!storeSession(updated)) return existing;
  return updated;
}

/** Deletes one Model Studio session. */
export function deleteStudioSession(id: string): boolean {
  if (!sessions.has(id)) return false;
  removeSession(id);
  return true;
}


