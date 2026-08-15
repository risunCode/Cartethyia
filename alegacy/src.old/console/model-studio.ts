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

export type StudioMediaType = "image" | "video";

export interface StudioMediaResult {
  readonly id: string;
  readonly type: StudioMediaType;
  readonly model: string;
  readonly prompt: string;
  readonly urls: readonly string[];
  readonly aspectRatio: string;
  readonly count: number;
  readonly createdAt: string;
}

export interface StudioSession {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly messages: readonly StudioMessage[];
  readonly media: readonly StudioMediaResult[];
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
const MAX_STUDIO_MEDIA_RESULTS = 24;
const MAX_STUDIO_MEDIA_URLS = 4;
const MAX_TITLE_CHARS = 200;
const MAX_MODEL_CHARS = 200;
const MAX_SYSTEM_PROMPT_CHARS = 32_000;
const MAX_MESSAGE_CONTENT_CHARS = 128_000;
const MAX_MESSAGE_REASONING_CHARS = 128_000;
const MAX_MESSAGE_IMAGES = 4;
const MAX_MESSAGE_IMAGE_CHARS = 256_000;
const MAX_MEDIA_PROMPT_CHARS = 16_000;
const MAX_MEDIA_URL_CHARS = 512_000;

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

function isStudioMediaResult(value: unknown): value is StudioMediaResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return typeof result.id === "string"
    && (result.type === "image" || result.type === "video")
    && typeof result.model === "string"
    && typeof result.prompt === "string"
    && Array.isArray(result.urls)
    && result.urls.every((url) => typeof url === "string")
    && typeof result.aspectRatio === "string"
    && typeof result.count === "number"
    && Number.isInteger(result.count)
    && result.count >= 1
    && result.count <= 4
    && typeof result.createdAt === "string";
}

function boundStudioMediaResult(result: StudioMediaResult): StudioMediaResult {
  return {
    id: boundedText(result.id, 64),
    type: result.type,
    model: boundedText(result.model, MAX_MODEL_CHARS),
    prompt: boundedText(result.prompt, MAX_MEDIA_PROMPT_CHARS),
    urls: result.urls.filter((url) => url.length <= MAX_MEDIA_URL_CHARS).slice(-MAX_STUDIO_MEDIA_URLS),
    aspectRatio: boundedText(result.aspectRatio, 16),
    count: Math.min(4, Math.max(1, Math.trunc(result.count))),
    createdAt: boundedText(result.createdAt, 64),
  };
}

/** Normalizes bounded media gallery metadata and rejects malformed entries. */
export function normalizeStudioMedia(value: unknown): StudioMediaResult[] | null {
  if (!Array.isArray(value) || !value.every(isStudioMediaResult)) return null;
  return value.slice(-MAX_STUDIO_MEDIA_RESULTS).map(boundStudioMediaResult);
}

function measureSession(session: StudioSession): number {
  let bytes = utf8Bytes(session.id) + utf8Bytes(session.title) + utf8Bytes(session.model) + utf8Bytes(session.systemPrompt) + utf8Bytes(session.createdAt) + utf8Bytes(session.updatedAt);
  for (const message of session.messages) {
    bytes += utf8Bytes(message.role) + utf8Bytes(message.content) + utf8Bytes(message.ts);
    if (message.reasoning !== undefined) bytes += utf8Bytes(message.reasoning);
    for (const image of message.images ?? []) bytes += utf8Bytes(image);
  }
  for (const result of session.media) {
    bytes += utf8Bytes(result.id) + utf8Bytes(result.type) + utf8Bytes(result.model) + utf8Bytes(result.prompt) + utf8Bytes(result.aspectRatio) + utf8Bytes(result.createdAt);
    for (const url of result.urls) bytes += utf8Bytes(url);
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
    media: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!storeSession(session)) throw new Error("Model Studio session memory limit reached");
  return session;
}

/** Updates session metadata and bounded message/media metadata from the Dashboard. */
export function patchStudioSession(id: string, input: { title?: string; model?: string; systemPrompt?: string; messages?: StudioMessage[]; media?: StudioMediaResult[] }): StudioSession | null {
  evictExpired();
  const existing = sessions.get(id);
  if (existing === undefined) return null;
  const updated: StudioSession = {
    ...existing,
    title: boundedText(input.title?.trim() || existing.title, MAX_TITLE_CHARS),
    model: boundedText(input.model?.trim() ?? existing.model, MAX_MODEL_CHARS),
    systemPrompt: boundedText(input.systemPrompt ?? existing.systemPrompt, MAX_SYSTEM_PROMPT_CHARS),
    messages: input.messages === undefined ? existing.messages : input.messages.slice(-MAX_STUDIO_MESSAGES).map(boundStudioMessage),
    media: input.media === undefined ? existing.media : input.media.slice(-MAX_STUDIO_MEDIA_RESULTS).map(boundStudioMediaResult),
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


