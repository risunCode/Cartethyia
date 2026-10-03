import { Cable, Brain, Coins, Fingerprint, Gauge, Info, Layers, RefreshCw, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { Inline } from "../../components/ui/inline";
import { Select } from "../../components/ui/select";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../shared/toast";
import type { ReasoningEffortLevel } from "../../../../src/transport/translation/thinking";
import {
  PROXY_UNSUPPORTED_HINT_PROVIDERS,
  ROUTING_ACTIVE_LABEL,
  useRoutingStrategy,
} from "../../hooks/use-routing-strategy";

/** Auto (send nothing) + the canonical ladder, minus `none` — a provider default
 * that forces reasoning off is not an option this page offers. */
const DEFAULT_REASONING_EFFORT_OPTIONS = [
  { value: "auto", label: "Auto (send nothing)" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-high" },
  { value: "max", label: "Max" },
] as const;

const USER_AGENT_PRESETS = [
  { value: "codex_cli_rs/0.156.1", label: "Codex" },
  { value: "claude-cli/2.1.280 (external, cli)", label: "Claude Code" },
] as const;

/** Shared shell for the grouped settings rows. */
function Row({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid var(--inner-border)",
        minWidth: 0,
      }}
    >
      {children}
    </div>
  );
}

export function RoutingStrategyCard({
  providerId,
  showUserAgent,
}: {
  readonly providerId: string;
  readonly showUserAgent: boolean;
}): ReactNode {
  const routing = useRoutingStrategy(providerId, showUserAgent);
  const showUnsupportedHint = PROXY_UNSUPPORTED_HINT_PROVIDERS.has(providerId);
  const userAgentOptions = USER_AGENT_PRESETS.some((option) => option.value === routing.userAgent)
    ? USER_AGENT_PRESETS
    : [...USER_AGENT_PRESETS, { value: routing.userAgent, label: "Custom" }];

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
  // Slider reads 1–100; `null` (unlimited) parks the thumb at the far right.
  const maxInflightValue =
    routing.maxInflight === null ? 100 : Math.min(100, Math.max(1, routing.maxInflight));
  const handleUserAgentChange = (next: string) => {
    if (next === routing.userAgent) return;
    routing.setUserAgent(next);
    const label = userAgentOptions.find((option) => option.value === next)?.label ?? next;
    toast.success("Client identity updated", label);
  };

  return (
    <Card>
      <CardHeader title="Routing Strategy" subtitle={subtitle} icon={<Layers size={16} />} />
      <CardBody>
        <div style={{ display: "grid", gap: "10px", width: "100%", minWidth: 0 }}>
          <Row>
            <div style={{ minWidth: 0 }}>
              <label htmlFor="routing-round-robin">
                <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                  <Repeat
                    size={15}
                    aria-hidden="true"
                    style={{
                      color: routing.roundRobinEnabled ? "var(--accent)" : "var(--text-tertiary)",
                      flexShrink: 0,
                    }}
                  />
                  Round robin
                </Inline>
              </label>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Off = failover: use accounts in priority order, fall through on failure. On = rotate
                requests across this provider's accounts.
              </div>
            </div>
            <Switch
              checked={routing.roundRobinEnabled}
              onChange={routing.setRoundRobinEnabled}
              id="routing-round-robin"
            />
          </Row>

          {routing.roundRobinEnabled ? (
            <Row>
              <div style={{ minWidth: 0 }}>
                <label htmlFor="routing-rotate-count">
                  <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                    <RefreshCw
                      size={15}
                      aria-hidden="true"
                      style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                    />
                    Accounts per rotation
                  </Inline>
                </label>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Requests served before the rotation advances
                </div>
              </div>
              <Inline gap="10px" style={{ flexShrink: 0 }}>
                <input
                  id="routing-rotate-count"
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={Math.min(10, routing.rotateCount)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value))
                      routing.setRotateCount(Math.min(1000, Math.max(1, Math.round(value))));
                  }}
                  style={{ width: "160px" }}
                />
                <input
                  type="number"
                  aria-label="Accounts per rotation"
                  min={1}
                  max={1000}
                  value={routing.rotateCount}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value))
                      routing.setRotateCount(Math.min(1000, Math.max(1, Math.round(value))));
                  }}
                  className="form-input"
                  style={{ width: "64px", textAlign: "center", padding: "6px 8px" }}
                />
              </Inline>
            </Row>
          ) : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "10px",
              minWidth: 0,
            }}
          >
            <div
              style={{
                padding: "10px 12px",
                borderRadius: "10px",
                border: "1px solid var(--inner-border)",
                minWidth: 0,
              }}
            >
              <div className="form-group">
                <label htmlFor="routing-max-inflight" className="form-label">
                  <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                    <Gauge
                      size={15}
                      aria-hidden="true"
                      style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                    />
                    Max inflight / account
                  </Inline>
                </label>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Shared provider ceiling
                </div>
                <Inline gap="10px" style={{ marginTop: "18px" }}>
                  <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: `${((maxInflightValue - 1) / 99) * 100}%`,
                        transform: "translate(-50%, -100%)",
                        marginTop: "-8px",
                        padding: "1px 6px",
                        borderRadius: "6px",
                        background: "var(--accent)",
                        color: "var(--accent-foreground)",
                        fontSize: "11px",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        pointerEvents: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {routing.maxInflight === null ? "∞" : maxInflightValue}
                    </span>
                    <input
                      id="routing-max-inflight"
                      type="range"
                      className="form-range"
                      min={1}
                      max={100}
                      step={1}
                      value={maxInflightValue}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value))
                          routing.setMaxInflight(Math.max(1, Math.round(value)));
                      }}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant={routing.maxInflight === null ? "primary" : "secondary"}
                    onClick={() => routing.setMaxInflight(null)}
                  >
                    Unlimited
                  </Button>
                </Inline>
              </div>
            </div>

            {showUserAgent ? (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "10px",
                  border: "1px solid var(--inner-border)",
                  minWidth: 0,
                }}
              >
                <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                  <Fingerprint
                    size={15}
                    aria-hidden="true"
                    style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                  />
                  Client identity
                </Inline>
                <Select
                  id="routing-user-agent-preset"
                  aria-label="Client identity"
                  value={routing.userAgent}
                  options={userAgentOptions}
                  onValueChange={handleUserAgentChange}
                />
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                  Adapter-owned identities are preserved.
                </div>
              </div>
            ) : null}
          </div>

          <Row>
            <div style={{ minWidth: 0 }}>
              <label htmlFor="routing-credit-floor">
                <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                  <Coins
                    size={15}
                    aria-hidden="true"
                    style={{
                      color: routing.creditFloor !== null ? "var(--accent)" : "var(--text-tertiary)",
                      flexShrink: 0,
                    }}
                  />
                  Credit floor / account
                </Inline>
              </label>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Keep this many credits unused. When an account reaches it, it cools down 24h and
                routing fails over. Blank = no reserve. Credit-metered providers only.
              </div>
            </div>
            <input
              id="routing-credit-floor"
              type="number"
              aria-label="Credit floor per account"
              min={0}
              max={1_000_000_000}
              placeholder="None"
              value={routing.creditFloor ?? ""}
              onChange={(event) => {
                const raw = event.target.value.trim();
                if (raw === "") {
                  routing.setCreditFloor(null);
                  return;
                }
                const value = Number(raw);
                if (Number.isFinite(value)) {
                  routing.setCreditFloor(Math.max(0, Math.min(1_000_000_000, Math.round(value))));
                }
              }}
              className="form-input"
              style={{ width: "110px", textAlign: "center", padding: "6px 8px", flexShrink: 0 }}
            />
          </Row>

          <Row>
            <div style={{ minWidth: 0 }}>
              <label htmlFor="routing-bypass-proxy">
                <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                  <Cable
                    size={15}
                    aria-hidden="true"
                    style={{
                      color: routing.bypassProxy ? "var(--accent)" : "var(--text-tertiary)",
                      flexShrink: 0,
                    }}
                  />
                  Always direct
                </Inline>
              </label>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Bypass automatic proxy-pool routing for this provider and always dial direct
              </div>
            </div>
            <Switch
              checked={routing.bypassProxy}
              onChange={routing.setBypassProxy}
              id="routing-bypass-proxy"
            />
          </Row>

          <Row>
            <div style={{ minWidth: 0 }}>
              <label htmlFor="routing-default-reasoning-effort">
                <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                  <Brain
                    size={15}
                    aria-hidden="true"
                    style={{
                      color:
                        routing.defaultReasoningEffort !== null ? "var(--accent)" : "var(--text-tertiary)",
                      flexShrink: 0,
                    }}
                  />
                  Default thinking effort
                </Inline>
              </label>
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                Applied to real requests through this provider when the client doesn't ask for a level
                itself. Requests carrying their own effort always win; combo member order is never
                affected. Auto = send nothing (previous behavior).
              </div>
            </div>
            <Select
              id="routing-default-reasoning-effort"
              aria-label="Default reasoning effort"
              value={routing.defaultReasoningEffort ?? "auto"}
              options={DEFAULT_REASONING_EFFORT_OPTIONS}
              onValueChange={(next) => routing.setDefaultReasoningEffort(next === "auto" ? null : (next as ReasoningEffortLevel))}
            />
          </Row>

          {showUnsupportedHint && (
            <Inline
              gap="6px"
              align="flex-start"
              style={{ fontSize: "11px", color: "var(--text-tertiary)" }}
            >
              <Info size={12} style={{ flexShrink: 0, marginTop: "1px" }} />
              <span>
                This provider doesn't reliably work through a plain HTTP/S proxy — use a SOCKS5 or
                proxy pool instead if you need to route it.
              </span>
            </Inline>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
