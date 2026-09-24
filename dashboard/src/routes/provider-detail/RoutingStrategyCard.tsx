import { Cable, Info, Layers, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Inline } from "../../components/ui/inline";
import { Input } from "../../components/ui/input";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Stack } from "../../components/ui/stack";
import { Switch } from "../../components/ui/switch";
import {
  PROXY_UNSUPPORTED_HINT_PROVIDERS,
  ROUTING_ACTIVE_LABEL,
  useRoutingStrategy,
} from "../../lib/use-routing-strategy";

export function RoutingStrategyCard({ providerId }: { readonly providerId: string }): ReactNode {
  const routing = useRoutingStrategy(providerId);
  const showUnsupportedHint = PROXY_UNSUPPORTED_HINT_PROVIDERS.has(providerId);

  if (routing.isLoading) return <LoadingState label="Loading routing..." />;
  if (routing.isError)
    return <ErrorState message="Failed to load routing" onRetry={routing.refetch} />;

  const activeLabel = routing.roundRobinEnabled
    ? `${ROUTING_ACTIVE_LABEL.roundRobin} · ${routing.rotateCount} account${routing.rotateCount === 1 ? "" : "s"} per rotation`
    : ROUTING_ACTIVE_LABEL.fallback;
  const subtitle = routing.isSaving
    ? "Saving..."
    : routing.saveFailed
      ? "Save failed — reverted to last saved value"
      : `Active: ${activeLabel}`;

  return (
    <Card>
      <CardHeader
        title="Routing Strategy"
        subtitle={subtitle}
        icon={<Layers size={16} />}
      />
      <CardBody>
        <Stack gap="10px">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              padding: "10px 12px",
              borderRadius: "10px",
              border: "1px solid var(--inner-border)",
            }}
          >
            <Inline gap="8px">
              <div>
                <label htmlFor="routing-round-robin">
                  <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                    <Repeat
                      size={15}
                      aria-hidden="true"
                      style={{ color: routing.roundRobinEnabled ? "var(--accent)" : "var(--text-tertiary)", flexShrink: 0 }}
                    />
                    Round robin
                  </Inline>
                </label>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Off = failover: use accounts in priority order, fall through on failure. On = rotate
                  requests across this provider's accounts.
                </div>
              </div>
            </Inline>
            <Switch
              checked={routing.roundRobinEnabled}
              onChange={routing.setRoundRobinEnabled}
              id="routing-round-robin"
            />
          </div>

          {routing.roundRobinEnabled ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                alignItems: "center",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "10px",
                border: "1px solid var(--inner-border)",
              }}
            >
              <div>
                <label htmlFor="routing-rotate-count" style={{ fontSize: "13px", fontWeight: 600 }}>
                  Accounts per rotation
                </label>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Requests served by one account before the rotation advances
                </div>
                <input
                  id="routing-rotate-count"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={Math.min(10, routing.rotateCount)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) routing.setRotateCount(Math.min(1000, Math.max(1, Math.round(value))));
                  }}
                  style={{ width: "100%", marginTop: "8px" }}
                />
              </div>
              <Input
                label="Accounts"
                type="number"
                min={1}
                max={1000}
                value={String(routing.rotateCount)}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) routing.setRotateCount(Math.min(1000, Math.max(1, Math.round(value))));
                }}
              />
            </div>
          ) : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: "10px",
            }}
          >
            <Input
              label="Max inflight / account"
              type="number"
              min={1}
              max={10000}
              placeholder="default"
              value={routing.maxInflight === null ? "" : String(routing.maxInflight)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                if (raw === "") {
                  routing.setMaxInflight(null);
                  return;
                }
                const parsed = Number(raw);
                if (!Number.isFinite(parsed)) return;
                routing.setMaxInflight(Math.min(10000, Math.max(1, Math.round(parsed))));
              }}
              hint="Per-account concurrency ceiling; empty = unlimited"
            />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              padding: "10px 12px",
              borderRadius: "10px",
              border: "1px solid var(--inner-border)",
            }}
          >
            <Inline gap="8px">
              <div>
                <label htmlFor="routing-bypass-proxy">
                  <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                    <Cable
                      size={15}
                      aria-hidden="true"
                      style={{ color: routing.bypassProxy ? "var(--accent)" : "var(--text-tertiary)", flexShrink: 0 }}
                    />
                    Always direct
                  </Inline>
                </label>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Bypass automatic proxy-pool routing for this provider and always dial direct
                </div>
              </div>
            </Inline>
            <Switch
              checked={routing.bypassProxy}
              onChange={routing.setBypassProxy}
              id="routing-bypass-proxy"
            />
          </div>

          {showUnsupportedHint && (
                <Inline gap="6px" align="flex-start" style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              <Info size={12} style={{ flexShrink: 0, marginTop: "1px" }} />
              <span>
                This provider doesn't reliably work through a plain HTTP/S proxy — use a SOCKS5 or
                proxy pool instead if you need to route it.
              </span>
            </Inline>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
