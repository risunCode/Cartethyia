// Studio playground domain: Drizzle session store.
//
// Owns persistence and the row-to-view mapping; routes never touch Drizzle.

import { and, desc, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { studioSessions } from "../../../persistence/schema";
import {
  type StudioSessionRow,
  type StudioSessionStore,
} from "./contracts";

export class DrizzleStudioSessionStore implements StudioSessionStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async list(tenantId: string): Promise<readonly StudioSessionRow[]> {
    const rows = await this.db
      .select()
      .from(studioSessions)
      .where(eq(studioSessions.tenantId, tenantId))
      .orderBy(desc(studioSessions.updatedAt));
    return rows;
  }

  async listIdsOldestFirst(tenantId: string): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: studioSessions.id })
      .from(studioSessions)
      .where(eq(studioSessions.tenantId, tenantId))
      .orderBy(studioSessions.updatedAt);
    return rows.map((row) => row.id);
  }

  async get(tenantId: string, id: string): Promise<StudioSessionRow | undefined> {
    const rows = await this.db
      .select()
      .from(studioSessions)
      .where(and(eq(studioSessions.tenantId, tenantId), eq(studioSessions.id, id)))
      .limit(1);
    return rows[0];
  }

  async create(row: StudioSessionRow): Promise<void> {
    await this.db.insert(studioSessions).values({
      id: row.id,
      tenantId: row.tenantId,
      title: row.title,
      model: row.model,
      systemPrompt: row.systemPrompt,
      messagesJson: row.messagesJson,
      mediaJson: row.mediaJson,
    });
  }

  async update(
    tenantId: string,
    id: string,
    patch: Partial<StudioSessionRow> & { updatedAt: Date },
  ): Promise<StudioSessionRow | undefined> {
    const rows = await this.db
      .update(studioSessions)
      .set({
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.systemPrompt === undefined ? {} : { systemPrompt: patch.systemPrompt }),
        ...(patch.messagesJson === undefined ? {} : { messagesJson: patch.messagesJson }),
        ...(patch.mediaJson === undefined ? {} : { mediaJson: patch.mediaJson }),
        updatedAt: patch.updatedAt,
      })
      .where(and(eq(studioSessions.tenantId, tenantId), eq(studioSessions.id, id)))
      .returning();
    return rows[0];
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(studioSessions)
      .where(and(eq(studioSessions.tenantId, tenantId), eq(studioSessions.id, id)))
      .returning({ id: studioSessions.id });
    return rows.length > 0;
  }
}


