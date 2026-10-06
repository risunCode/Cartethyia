// Console authentication, sessions, lockouts, first-boot setup, and audit.
import { eq } from "drizzle-orm";
import {
  consoleUsers,
} from "../../persistence/schema";

import type { CartethyiaDatabase } from "../../persistence/db-handle";

export class ConsoleUserStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async findByUsername(username: string): Promise<unknown | undefined> {
    // Usernames are unique per tenant, not globally. Login carries no tenant, so
    // a name that matches exactly one user still resolves; a name shared by two
    // tenants is refused rather than guessed.
    const rows = await this.db.select().from(consoleUsers).where(eq(consoleUsers.username, username)).limit(2);
    if (rows.length !== 1) return undefined;
    return rows[0];
  }

  async findById(userId: string): Promise<unknown | undefined> {
    const rows = await this.db.select().from(consoleUsers).where(eq(consoleUsers.id, userId)).limit(1);
    return rows[0];
  }

  async findAny(): Promise<unknown[]> {
    return this.db.select().from(consoleUsers).limit(1);
  }
}

export async function readUsers(db: CartethyiaDatabase, username?: string): Promise<unknown[]> {
  const store = new ConsoleUserStore(db);
  if (username === undefined) return store.findAny();
  const user = await store.findByUsername(username);
  return user ? [user] : [];
}
export async function readUser(db: CartethyiaDatabase, userId: string): Promise<unknown> {
  return new ConsoleUserStore(db).findById(userId);
}

// ---- credentials.ts ----
