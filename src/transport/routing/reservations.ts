// In-memory reservation lease store with lazy TTL cleanup.
import type { Reservation, RouteCandidate, RoutingRevision } from "./route-model";

/**
 * In-memory reservation lease store with lazy TTL cleanup. The bounded sweep
 * runs before acquisition so abandoned local metadata cannot grow forever.
 */
export class ReservationManager {
  private leases = new Map<string, Reservation>();
  private lastSweepAt = 0;
  private static readonly SWEEP_INTERVAL_MS = 30_000;

  private sweepExpired(now: number): void {
    if (now - this.lastSweepAt < ReservationManager.SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const [leaseId, reservation] of this.leases) {
      if (reservation.expires_at < now) this.leases.delete(leaseId);
    }
  }

  acquire(candidate: RouteCandidate, _revision: RoutingRevision, ttlMs = 30_000): Reservation {
    const now = Date.now();
    this.sweepExpired(now);
    const lease_id = `${candidate.provider_id}:${candidate.model_id}:${now}:${Math.random().toString(16).slice(2)}`;
    const r: Reservation = {
      candidate,
      lease_id,
      acquired_at: now,
      expires_at: now + ttlMs,
    };
    this.leases.set(lease_id, r);
    return r;
  }

  release(lease_id: string): void {
    this.leases.delete(lease_id);
  }

  get(lease_id: string): Reservation | undefined {
    const r = this.leases.get(lease_id);
    if (!r) return undefined;
    if (r.expires_at < Date.now()) {
      this.leases.delete(lease_id);
      return undefined;
    }
    return r;
  }

  /** Test/diagnostic seam: current lease count without triggering a sweep. */
  size(): number {
    return this.leases.size;
  }
}
