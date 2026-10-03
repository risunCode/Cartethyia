import { useEffect, useState } from "react";
import { useProviderRouting, useUpdateProviderRouting } from "./routing";
import { useDebouncedSave } from "./use-debounced-save";
import type { ProviderRoutingResponse } from "../data/contracts";
import type { ReasoningEffortLevel } from "../../../src/transport/translation/thinking";

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
  readonly creditFloor: number | null;
  readonly bypassProxy: boolean;
  readonly userAgent: string;
  readonly setUserAgent: (next: string) => void;
  /** Provider default reasoning effort; `null` = auto (send nothing). */
  readonly defaultReasoningEffort: ReasoningEffortLevel | null;
  readonly setDefaultReasoningEffort: (next: ReasoningEffortLevel | null) => void;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly isSaving: boolean;
  readonly saveFailed: boolean;
  readonly refetch: () => void;
  readonly setMaxInflight: (next: number | null) => void;
  readonly setCreditFloor: (next: number | null) => void;
  readonly setBypassProxy: (next: boolean) => void;
}

export function useRoutingStrategy(providerId: string, allowUserAgent: boolean): RoutingStrategyState {
  const query = useProviderRouting(providerId);
  const mutation = useUpdateProviderRouting();
  const [strategy, setStrategyState] = useState<RoutingStrategy>("fallback");
  const [rotateCount, setRotateCountState] = useState(1);
  const [maxInflight, setMaxInflightState] = useState<number | null>(null);
  const [creditFloor, setCreditFloorState] = useState<number | null>(null);
  const [bypassProxy, setBypassProxyState] = useState(false);
  const [userAgent, setUserAgentState] = useState("codex_cli_rs/0.156.1");
  const [defaultReasoningEffort, setDefaultReasoningEffortState] = useState<ReasoningEffortLevel | null>(null);

  useEffect(() => {
    if (!query.data) return;
    setStrategyState(query.data.strategy);
    setRotateCountState(query.data.rotateCount);
    setMaxInflightState(query.data.maxInflight);
    setCreditFloorState(query.data.creditFloor);
    setBypassProxyState(query.data.bypassProxy);
    setUserAgentState(query.data.userAgent);
    setDefaultReasoningEffortState(query.data.defaultReasoningEffort ?? null);
  }, [query.data]);

  const save = (next: {
    strategy: RoutingStrategy;
    rotateCount: number;
    maxInflight: number | null;
    creditFloor: number | null;
    bypassProxy: boolean;
    userAgent: string;
    defaultReasoningEffort: ReasoningEffortLevel | null;
  }) => {
    mutation.mutate(
      {
        providerId,
        request: {
          enabled: true,
          strategy: next.strategy,
          rotateCount: next.rotateCount,
          maxInflight: next.maxInflight,
          creditFloor: next.creditFloor,
          bypassProxy: next.bypassProxy,
          defaultReasoningEffort: next.defaultReasoningEffort,
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
          setDefaultReasoningEffortState(query.data.defaultReasoningEffort ?? null);
        },
      },
    );
  };
  const scheduleMaxInflightSave = useDebouncedSave((next: number | null) =>
    save({ strategy, rotateCount, maxInflight: next, creditFloor, bypassProxy, userAgent, defaultReasoningEffort }),
  );
  const scheduleCreditFloorSave = useDebouncedSave((next: number | null) =>
    save({ strategy, rotateCount, maxInflight, creditFloor: next, bypassProxy, userAgent, defaultReasoningEffort }),
  );
  const scheduleRotateCountSave = useDebouncedSave((next: number) =>
    save({ strategy, rotateCount: next, maxInflight, creditFloor, bypassProxy, userAgent, defaultReasoningEffort }),
  );
  const scheduleUserAgentSave = useDebouncedSave((next: string) =>
    save({ strategy, rotateCount, maxInflight, creditFloor, bypassProxy, userAgent: next, defaultReasoningEffort }),
  );
  const scheduleEffortSave = useDebouncedSave((next: ReasoningEffortLevel | null) =>
    save({ strategy, rotateCount, maxInflight, creditFloor, bypassProxy, userAgent, defaultReasoningEffort: next }),
  );

  return {
    strategy,
    maxInflight,
    creditFloor,
    bypassProxy,
    userAgent,
    defaultReasoningEffort,
    isLoading: query.isPending,
    isError: query.isError,
    isSaving: mutation.isPending,
    saveFailed: mutation.isError,
    refetch: () => query.refetch(),
    setMaxInflight: (next) => {
      setMaxInflightState(next);
      scheduleMaxInflightSave(next);
    },
    setCreditFloor: (next) => {
      setCreditFloorState(next);
      scheduleCreditFloorSave(next);
    },
    setUserAgent: (next) => {
      setUserAgentState(next);
      scheduleUserAgentSave(next);
    },
    setDefaultReasoningEffort: (next) => {
      setDefaultReasoningEffortState(next);
      scheduleEffortSave(next);
    },
    setBypassProxy: (next) => {
      setBypassProxyState(next);
      save({ strategy, rotateCount, maxInflight, creditFloor, bypassProxy: next, userAgent, defaultReasoningEffort });
    },
    roundRobinEnabled: strategy === "round_robin",
    setRoundRobinEnabled: (next) => {
      const resolved: RoutingStrategy = next ? "round_robin" : "fallback";
      setStrategyState(resolved);
      save({ strategy: resolved, rotateCount, maxInflight, creditFloor, bypassProxy, userAgent, defaultReasoningEffort });
    },
    rotateCount,
    setRotateCount: (next) => {
      setRotateCountState(next);
      scheduleRotateCountSave(next);
    },
  };
}
