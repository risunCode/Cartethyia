/** Proxy adapter type definitions — shared by the fetcher builder, the pool, and the console API. */

export type ProxyProtocol = "http" | "https" | "socks5";

/**
 * Minimal shape a fetcher/connector needs to build a tunnel — decoupled from
 * the DB row so `adapter.ts`/`socket.ts` have no DB dependency (`id` is
 * carried only so `dispatch.ts` can report a connection failure back to the
 * pool via `markProxyUnavailable`; the tunneling code itself never reads it).
 */
export interface ProxyTarget {
  id: string;
  name?: string;
  protocol: ProxyProtocol;
  isRelay?: boolean;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

/** Same shape every provider's `fetcher` override already uses (see `simple-call.ts`). */
export type ProxyFetcher = (url: string, init: RequestInit) => Promise<Response>;
