// Studio playground domain: persisted-session model shared by the store and routes.
//
// This module is the single source for the session view, the per-entry
// normalization bounds, and the key-issuance rule; store and routes consume
// it, they do not redeclare it.

import { isRecord } from "../../../protocol/primitives";
import type { studioSessions } from "../../../persistence/schema";

export interface StudioMessageUsage {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cached?: number;
  readonly total?: number;
}

export interface StudioToolCall {
  readonly name: string;
  readonly args: string;
  readonly result: string;
}

export interface StudioToolRound {
  readonly toolCalls: readonly StudioToolCall[];
}

export interface StudioMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly reasoning?: string;
  readonly usage?: StudioMessageUsage;
  readonly ttfbMs?: number;
  /** Wall-clock time from send to turn completion. */
  readonly completionMs?: number;
  /** Client-executed tool calls grouped by sequential model turn.
   * This is the single source: persisted entries without `toolRounds`
   * normalize from their wire order on read. Never written separately. */
  readonly toolRounds?: readonly StudioToolRound[];
  /** Flattened tool calls for display, derived from `toolRounds`. */
  readonly toolCalls?: readonly StudioToolCall[];
  /** Outbound attachments replayed as multimodal wire parts on user turns. */
  readonly attachments?: readonly StudioAttachment[];
  readonly ts: string;
}

export interface StudioAttachment {
  /** image → image_url, file → input_file, audio → input_audio. */
  readonly kind: "image" | "file" | "audio";
  readonly name: string;
  readonly mime: string;
  /** Always a `data:` URL; the wire builder strips the prefix where needed. */
  readonly dataUrl: string;
}

export interface StudioMediaResult {
  readonly id: string;
  readonly type: "image";
  readonly model: string;
  readonly prompt: string;
  readonly urls: readonly string[];
  readonly createdAt: string;
}

export interface StudioSessionView {
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
  readonly updatedAt: string;
  readonly messageCount: number;
}

/** Storage bounds: sessions stay small, countable, and evictable. */
export const STUDIO_MAX_SESSIONS_PER_TENANT = 50;
export const STUDIO_MAX_MESSAGES = 200;
export const STUDIO_MAX_MEDIA_RESULTS = 24;
export const STUDIO_LIMIT_TITLE = 200;
export const STUDIO_LIMIT_MODEL = 200;
export const STUDIO_LIMIT_SYSTEM_PROMPT = 32_000;
export const STUDIO_LIMIT_CONTENT = 128_000;
export const STUDIO_LIMIT_TOOL_CALLS = 10;
export const STUDIO_LIMIT_TOOL_ROUNDS = 10;
export const STUDIO_LIMIT_TOOL_TEXT = 4_000;
export const STUDIO_LIMIT_ATTACHMENTS = 4;
export const STUDIO_LIMIT_ATTACHMENT_CHARS = 2_000_000;
export const STUDIO_LIMIT_FILENAME = 200;
export const STUDIO_LIMIT_MIME = 127;
export const STUDIO_LIMIT_URLS = 4;
export const STUDIO_LIMIT_URL_LENGTH = 512_000;

export function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= max ? value : undefined;
}

export function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}


function normalizeUsage(value: unknown): StudioMessageUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: Record<string, number> = {};
  for (const key of ["input", "output", "reasoning", "cached", "total"] as const) {
    const n = boundedNumber(value[key]);
    if (n !== undefined) usage[key] = n;
  }
  return Object.keys(usage).length > 0 ? (usage as StudioMessageUsage) : undefined;
}

function normalizeMessage(value: unknown): StudioMessage | undefined {
  if (!isRecord(value)) return undefined;
  const role = value["role"];
  if (role !== "system" && role !== "user" && role !== "assistant") return undefined;
  const content = boundedString(value["content"], STUDIO_LIMIT_CONTENT);
  if (content === undefined) return undefined;
  const ts = typeof value["ts"] === "string" ? value["ts"] : new Date().toISOString();
  const reasoning = boundedString(value["reasoning"], STUDIO_LIMIT_CONTENT);
  const usage = normalizeUsage(value["usage"]);
  const ttfbMs = boundedNumber(value["ttfbMs"]);
  const completionMs = boundedNumber(value["completionMs"]);
  const toolRounds = normalizeToolRounds(value["toolRounds"]);
  const flattenedToolRounds = toolRounds?.flatMap((round) => round.toolCalls);
  const normalizedToolCalls = flattenedToolRounds;
  const attachments = normalizeAttachments(value["attachments"]);
  const message: StudioMessage = {
    role,
    content,
    ts,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(usage === undefined ? {} : { usage }),
    ...(ttfbMs === undefined ? {} : { ttfbMs }),
    ...(completionMs === undefined ? {} : { completionMs }),
    ...(toolRounds === undefined ? {} : { toolRounds }),
    ...(normalizedToolCalls === undefined ? {} : { toolCalls: normalizedToolCalls }),
    ...(attachments === undefined ? {} : { attachments }),
  };
  return message;
}

function normalizeAttachments(value: unknown): readonly StudioAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > STUDIO_LIMIT_ATTACHMENTS) return undefined;
  const attachments: StudioAttachment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const kind = entry["kind"];
    if (kind !== "image" && kind !== "file" && kind !== "audio") return undefined;
    const name = boundedString(entry["name"], STUDIO_LIMIT_FILENAME);
    const mime = boundedString(entry["mime"], STUDIO_LIMIT_MIME);
    const dataUrl = boundedString(entry["dataUrl"], STUDIO_LIMIT_ATTACHMENT_CHARS);
    if (name === undefined || mime === undefined || dataUrl === undefined) return undefined;
    if (!dataUrl.startsWith("data:")) return undefined;
    attachments.push({ kind, name, mime, dataUrl });
  }
  if (attachments.length === 0) return undefined;
  return attachments;
}

function normalizeToolCalls(value: unknown): readonly StudioToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: StudioToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const name = boundedString(entry["name"], 200);
    const args = boundedString(entry["args"], STUDIO_LIMIT_TOOL_TEXT);
    const result = boundedString(entry["result"], STUDIO_LIMIT_TOOL_TEXT);
    if (name === undefined || args === undefined || result === undefined) return undefined;
    calls.push({ name, args, result });
  }
  if (calls.length === 0) return undefined;
  return calls.slice(-STUDIO_LIMIT_TOOL_CALLS);
}

function normalizeToolRounds(value: unknown): readonly StudioToolRound[] | undefined {
  if (!Array.isArray(value) || value.length > STUDIO_LIMIT_TOOL_ROUNDS) return undefined;
  const rounds: StudioToolRound[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const toolCalls = normalizeToolCalls(entry["toolCalls"]);
    if (toolCalls === undefined) return undefined;
    rounds.push({ toolCalls });
  }
  return rounds.length === 0 ? undefined : rounds;
}

export function normalizeStudioMessages(value: unknown): StudioMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: StudioMessage[] = [];
  for (const entry of value) {
    const message = normalizeMessage(entry);
    if (message === undefined) return null;
    messages.push(message);
  }
  return messages.slice(-STUDIO_MAX_MESSAGES);
}

function normalizeMediaResult(value: unknown): StudioMediaResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value["type"] !== "image") return undefined;
  if (typeof value["id"] !== "string" || value["id"].length === 0) return undefined;
  const model = boundedString(value["model"], STUDIO_LIMIT_MODEL);
  const prompt = boundedString(value["prompt"], STUDIO_LIMIT_CONTENT);
  if (model === undefined || prompt === undefined) return undefined;
  const rawUrls = value["urls"];
  if (!Array.isArray(rawUrls) || rawUrls.length > STUDIO_LIMIT_URLS) return undefined;
  const urls: string[] = [];
  for (const url of rawUrls) {
    const bounded = boundedString(url, STUDIO_LIMIT_URL_LENGTH);
    if (bounded === undefined) return undefined;
    urls.push(bounded);
  }
  const createdAt =
    typeof value["createdAt"] === "string" ? value["createdAt"] : new Date().toISOString();
  return { id: value["id"] as string, type: "image", model, prompt, urls, createdAt };
}

export function normalizeStudioMedia(value: unknown): StudioMediaResult[] | null {
  if (!Array.isArray(value)) return null;
  const media: StudioMediaResult[] = [];
  for (const entry of value) {
    const result = normalizeMediaResult(entry);
    if (result === undefined) return null;
    media.push(result);
  }
  return media.slice(-STUDIO_MAX_MEDIA_RESULTS);
}



export interface StudioSessionStore {
  list(tenantId: string): Promise<readonly StudioSessionRow[]>;
  get(tenantId: string, id: string): Promise<StudioSessionRow | undefined>;
  create(row: StudioSessionRow): Promise<void>;
  update(
    tenantId: string,
    id: string,
    patch: Partial<StudioSessionRow> & { updatedAt: Date },
  ): Promise<StudioSessionRow | undefined>;
  delete(tenantId: string, id: string): Promise<boolean>;
  /** Oldest-first ids for cap eviction. */
  listIdsOldestFirst(tenantId: string): Promise<readonly string[]>;
}

/**
 * A persisted Studio session row. Derived from the table rather than restating
 * its nine columns, so a schema change reaches every consumer — the store
 * already read `typeof studioSessions.$inferSelect`.
 */
export type StudioSessionRow = typeof studioSessions.$inferSelect;

export function toSession(row: StudioSessionRow): StudioSessionView {
  // Normalize on read too: rows written by older bounds stay servable.
  const messages = normalizeStudioMessages(row.messagesJson) ?? [];
  const media = normalizeStudioMedia(row.mediaJson) ?? [];
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    systemPrompt: row.systemPrompt,
    messages,
    media,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSummary(row: StudioSessionRow): StudioSessionSummary {
  const messages = normalizeStudioMessages(row.messagesJson) ?? [];
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    updatedAt: row.updatedAt.toISOString(),
    messageCount: messages.length,
  };
}
