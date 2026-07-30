/**
 * Model Studio — saved chat sessions for the console's built-in model tester
 * (design: manual system prompt + remembered turns, switchable sessions so
 * provider prompt caching survives a session switch).
 */

import { getDb } from "../client";

export interface StudioMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** ISO timestamp the message was appended, for display only. */
  ts: string;
  /** Data-URL image attachments (user turns only). */
  images?: string[];
}

interface SessionRow {
  id: string;
  title: string;
  model: string;
  system_prompt: string;
  messages_json: string;
  created_at: string;
  updated_at: string;
}

export interface StudioSession {
  id: string;
  title: string;
  model: string;
  systemPrompt: string;
  messages: StudioMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface StudioSessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

function parseMessages(json: string): StudioMessage[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StudioMessage =>
        typeof entry === "object" && entry !== null && typeof (entry as StudioMessage).role === "string" && typeof (entry as StudioMessage).content === "string"
    );
  } catch {
    return [];
  }
}

export function listStudioSessions(): StudioSessionSummary[] {
  const rows = getDb().query("SELECT * FROM model_studio_sessions ORDER BY updated_at DESC").all() as SessionRow[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    model: row.model,
    messageCount: parseMessages(row.messages_json).length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getStudioSession(id: string): StudioSession | null {
  const row = getDb().query("SELECT * FROM model_studio_sessions WHERE id = ?").get(id) as SessionRow | null;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    systemPrompt: row.system_prompt,
    messages: parseMessages(row.messages_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateStudioSessionInput {
  title: string;
  model?: string;
  systemPrompt?: string;
}

export function createStudioSession(input: CreateStudioSessionInput): StudioSession {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .query(
      "INSERT INTO model_studio_sessions (id, title, model, system_prompt, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?)"
    )
    .run(id, input.title.trim() || "New session", input.model ?? "", input.systemPrompt ?? "", now, now);
  return { id, title: input.title.trim() || "New session", model: input.model ?? "", systemPrompt: input.systemPrompt ?? "", messages: [], createdAt: now, updatedAt: now };
}

export interface PatchStudioSessionInput {
  title?: string;
  model?: string;
  systemPrompt?: string;
  messages?: StudioMessage[];
}

export function patchStudioSession(id: string, patch: PatchStudioSessionInput): StudioSession | null {
  const current = getStudioSession(id);
  if (!current) return null;
  const next: StudioSession = {
    ...current,
    title: patch.title !== undefined ? patch.title.trim() || current.title : current.title,
    model: patch.model !== undefined ? patch.model : current.model,
    systemPrompt: patch.systemPrompt !== undefined ? patch.systemPrompt : current.systemPrompt,
    messages: patch.messages !== undefined ? patch.messages : current.messages,
    updatedAt: new Date().toISOString(),
  };
  getDb()
    .query("UPDATE model_studio_sessions SET title = ?, model = ?, system_prompt = ?, messages_json = ?, updated_at = ? WHERE id = ?")
    .run(next.title, next.model, next.systemPrompt, JSON.stringify(next.messages), next.updatedAt, id);
  return next;
}

export function deleteStudioSession(id: string): boolean {
  const result = getDb().query("DELETE FROM model_studio_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}
