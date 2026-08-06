import type { AuthDriver } from "./contracts";
import { CodexOAuthDriver } from "./oauth";

/** A provider-id keyed {@link AuthDriver} registration. */
export interface AuthDriverEntry {
  readonly providerId: string;
  readonly driver: AuthDriver;
}

/**
 * Provider-aware OAuth driver lookup. The registry is the single injection
 * point for provider auth drivers: a provider adapter never looks up a driver
 * by id itself, and a provider with no registered driver simply has no OAuth
 * flow (no hardcoded exclusion lists — absence is the only rejection).
 */
export interface AuthDriverRegistry {
  get(providerId: string): AuthDriver | null;
  has(providerId: string): boolean;
  list(): readonly AuthDriverEntry[];
  register(providerId: string, driver: AuthDriver): void;
}

/** Bounded in-memory {@link AuthDriverRegistry}; later registrations replace earlier ones for the same id. */
export class MapAuthDriverRegistry implements AuthDriverRegistry {
  private readonly drivers = new Map<string, AuthDriver>();

  get(providerId: string): AuthDriver | null {
    return this.drivers.get(providerId) ?? null;
  }

  has(providerId: string): boolean {
    return this.drivers.has(providerId);
  }

  list(): readonly AuthDriverEntry[] {
    return [...this.drivers.entries()].map(([providerId, driver]) => ({ providerId, driver }));
  }

  register(providerId: string, driver: AuthDriver): void {
    if (providerId.length === 0) throw new Error("provider id must not be empty");
    this.drivers.set(providerId, driver);
  }
}

/**
 * Default driver registry with the bundled OAuth drivers registered. Adapter
 * agents register additional provider drivers (Kiro, Cline, Qoder, Antigravity,
 * Anthropic OAuth, ...) onto this registry from composition; providers without
 * a registered driver have no interactive OAuth surface.
 */
export function createAuthDriverRegistry(initial: readonly AuthDriverEntry[] = []): AuthDriverRegistry {
  const registry = new MapAuthDriverRegistry();
  registry.register("codex", new CodexOAuthDriver());
  for (const entry of initial) registry.register(entry.providerId, entry.driver);
  return registry;
}