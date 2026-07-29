/** In-process audit trail for the current server lifetime. */

const MAX_EVENTS = 1_000;
let nextId = 1;
const events: AuditEvent[] = [];

export interface AuditEvent {
  id: number;
  type: string;
  actor: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export function addAuditEvent(type: string, detail: Record<string, unknown> = {}, actor = "admin"): void {
  events.push({ id: nextId++, type, actor, detail, createdAt: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.shift();
}

export function listAuditEvents(limit = 100): AuditEvent[] {
  return events.slice(-limit).reverse();
}
