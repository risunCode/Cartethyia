import { useEffect, useState } from "react";
import { useProviderRouting, useUpdateProviderRouting } from "./routing";
import { useDebouncedSave } from "./use-debounced-save";
import type { ProviderRoutingResponse } from "../data/contracts";

export type RoutingStrategy = ProviderRoutingResponse["strategy"];

export const ROUTING_ACTIVE_LABEL = {
  fallback: "Failover",
  roundRobin: "Round robin",
} as const;

// Providers known to not reliably support plain HTTP/S proxying — routing
// for these defaults to bypassProxy on the backend. Dashboard copy of the
// backend `DEFAULT_PROXY_BYPASS_PROVIDER_IDS` (`src/providers/provider-metadata.ts`).
// Intentionally duplicated, not imported: importing the backend value would
// bundle the backend module graph (Elysia + `node:crypto`) into the browser
// build and break Vite dev with "Module node:crypto has been externalized".
// Same precedent as the dashboard `isRecord` copy in `lib/api.ts`.
// This set only decides whether the UI shows an explanatory tip; the backend
// constant is what actually enforces the default. Keep in sync.
export const PROXY_UNSUPPORTED_HINT_PROVIDERS: ReadonlySet<string> = new Set([
  "inferhub",
]);

export interface RoutingStrategyState {
  readonly strategy: RoutingStrategy;
  readonly roundRobinEnabled: boolean;
  readonly setRoundRobinEnabled: (next: boolean) => void;
  readonly rotateCount: number;
  readonly setRotateCount: (next: number) => void;
  readonly maxInflight: number | null;
  readonly bypassProxy: boolean;
  readonly userAgent: string;
  readonly setUserAgent: (next: string) => void;
  /** Global credit limit toggle for every account of this provider/tenant. */
  readonly creditLimitEnabled: boolean;
  readonly setCreditLimitEnabled: (next: boolean) => void;
  /** Global minimum remaining credits to keep on every account; default 200. */
  readonly creditLimit: number;
  readonly setCreditLimit: (next: number) => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isSaving: boolean;
  readonly saveFailed: boolean;
  readonly refetch: () => void;
  readonly setMaxInflight: (next: number | null) => void;
  readonly setBypassProxy: (next: boolean) => void;
}

export function useRoutingStrategy(providerId: string, allowUserAgent: boolean): RoutingStrategyState {
  const query = useProviderRouting(providerId);
  const mutation = useUpdateProviderRouting();
  const [strategy, setStrategyState] = useState<RoutingStrategy>("fallback");
  const [rotateCount, setRotateCountState] = useState(1);
  const [maxInflight, setMaxInflightState] = useState<number | null>(null);
  const [bypassProxy, setBypassProxyState] = useState(false);
  const [userAgent, setUserAgentState] = useState("codex_cli_rs/0.156.1");
  const [creditLimitEnabled, setCreditLimitEnabledState] = useState(true);
  const [creditLimit, setCreditLimitState] = useState(200);

  useEffect(() => {
    if (!query.data) return;
    setStrategyState(query.data.strategy);
    setRotateCountState(query.data.rotateCount);
    setMaxInflightState(query.data.maxInflight);
    setBypassProxyState(query.data.bypassProxy);
    setUserAgentState(query.data.userAgent);
    setCreditLimitEnabledState(query.data.creditLimitEnabled);
    setCreditLimitState(query.data.creditLimit);
  }, [query.data]);

  const save = (next: {
    strategy: RoutingStrategy;
    rotateCount: number;
    maxInflight: number | null;
    bypassProxy: boolean;
    userAgent: string;
    creditLimitEnabled: boolean;
    creditLimit: number;
  }) => {
    mutation.mutate(
      {
        providerId,
        request: {
          enabled: true,
          strategy: next.strategy,
          rotateCount: next.rotateCount,
          maxInflight: next.maxInflight,
          bypassProxy: next.bypassProxy,
          creditLimitEnabled: next.creditLimitEnabled,
          creditLimit: next.creditLimit,
          ...(allowUserAgent ? { userAgent: next.userAgent } : {}),
        },
      },
      {
        onError: () => {
          if (!query.data) return;
          setStrategyState(query.data.strategy);
          setRotateCountState(query.data.rotateCount);
          setBypassProxyState(query.data.bypassProxy);
          setUserAgentState(query.data.userAgent);
          setCreditLimitEnabledState(query.data.creditLimitEnabled);
          setCreditLimitState(query.data.creditLimit);
        },
      },
    );
  };
  const scheduleMaxInflightSave = useDebouncedSave((next: number | null) =>
    save({
      strategy,
      rotateCount,
      maxInflight: next,
      bypassProxy,
      userAgent,
      creditLimitEnabled,
      creditLimit,
    }),
  );
  const scheduleRotateCountSave = useDebouncedSave((next: number) =>
    save({
      strategy,
      rotateCount: next,
      maxInflight,
      bypassProxy,
      userAgent,
      creditLimitEnabled,
      creditLimit,
    }),
  );
  const scheduleUserAgentSave = useDebouncedSave((next: string) =>
    save({
      strategy,
      rotateCount,
      maxInflight,
      bypassProxy,
      userAgent: next,
      creditLimitEnabled,
      creditLimit,
    }),
  );
  const scheduleCreditLimitSave = useDebouncedSave((next: number) =>
    save({
      strategy,
      rotateCount,
      maxInflight,
      bypassProxy,
      userAgent,
      creditLimitEnabled,
      creditLimit: next,
    }),
  );

  return {
    strategy,
    maxInflight,
    bypassProxy,
    userAgent,
    creditLimitEnabled,
    creditLimit,
    isLoading: query.isPending,
    isError: query.isError,
    isSaving: mutation.isPending,
    saveFailed: mutation.isError,
    refetch: () => query.refetch(),
    setMaxInflight: (next) => {
      setMaxInflightState(next);
      scheduleMaxInflightSave(next);
    },
    setUserAgent: (next) => {
      setUserAgentState(next);
      scheduleUserAgentSave(next);
    },
    setBypassProxy: (next) => {
      setBypassProxyState(next);
      save({
        strategy,
        rotateCount,
        maxInflight,
        bypassProxy: next,
        userAgent,
        creditLimitEnabled,
        creditLimit,
      });
    },
    setCreditLimitEnabled: (next) => {
      setCreditLimitEnabledState(next);
      save({
        strategy,
        rotateCount,
        maxInflight,
        bypassProxy,
        userAgent,
        creditLimitEnabled: next,
        creditLimit,
      });
    },
    setCreditLimit: (next) => {
      setCreditLimitState(next);
      scheduleCreditLimitSave(next);
    },
    roundRobinEnabled: strategy === "round_robin",
    setRoundRobinEnabled: (next) => {
      const resolved: RoutingStrategy = next ? "round_robin" : "fallback";
      setStrategyState(resolved);
      save({
        strategy: resolved,
        rotateCount,
        maxInflight,
        bypassProxy,
        userAgent,
        creditLimitEnabled,
        creditLimit,
      });
    },
    rotateCount,
    setRotateCount: (next) => {
      setRotateCountState(next);
      scheduleRotateCountSave(next);
    },
  };
}
