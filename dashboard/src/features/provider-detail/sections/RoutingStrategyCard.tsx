import { Cable, Fingerprint, Gauge, Info, Layers, RefreshCw, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Inline } from "../../../components/ui/inline";
import { Select } from "../../../components/ui/select";
import { ErrorState, LoadingState } from "../../../components/ui/state";
import { Switch } from "../../../components/ui/switch";
import { toast } from "../../../lib/toast";
import {
  PROXY_UNSUPPORTED_HINT_PROVIDERS,
  ROUTING_ACTIVE_LABEL,
  useRoutingStrategy,
} from "../../../hooks/use-routing-strategy";

/** The slider's own scale: 1–50, with one step past the end meaning unlimited. */
const SLIDER_MAX = 50;
/** A typed number may go past the slider, but not past this. */
const MANUAL_MAX = 100;
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
  clientVersion,
  userAgentEditable,
}: {
  readonly providerId: string;
  /** The provider's own discovered client, shown when its identity is fixed. */
  readonly clientVersion?: { readonly client: string; readonly version: string };
  /** False when the provider stamps its own identity, so the shown value cannot be changed. */
  readonly userAgentEditable: boolean;
}): ReactNode {
  const routing = useRoutingStrategy(providerId, userAgentEditable);
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
  // The slider stops at 50; one step further is unlimited. A typed value above
  // 50 still shows, parked at the end with its real number beside it.
  const unlimited = routing.maxInflight === null;
  const sliderValue = unlimited ? SLIDER_MAX + 1 : Math.min(SLIDER_MAX + 1, Math.max(1, routing.maxInflight));
  const shownValue = unlimited ? "∞" : String(routing.maxInflight);
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
              <input
                id="routing-rotate-count"
                type="number"
                min={1}
                max={1000}
                value={routing.rotateCount}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value))
                    routing.setRotateCount(Math.min(1000, Math.max(1, Math.round(value))));
                }}
                className="form-input"
                style={{ width: "72px", flexShrink: 0, textAlign: "center", padding: "6px 8px" }}
              />
            </Row>
          ) : null}

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
              <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>
                <Fingerprint
                  size={15}
                  aria-hidden="true"
                  style={{ color: "var(--text-tertiary)", flexShrink: 0 }}
                />
                Client identity
              </Inline>
              {userAgentEditable ? (
                <Select
                  id="routing-user-agent-preset"
                  aria-label="Client identity"
                  value={routing.userAgent}
                  options={userAgentOptions}
                  onValueChange={handleUserAgentChange}
                />
              ) : (
                <div aria-label="Client identity" className="form-input" aria-disabled="true">
                  {clientVersion
                    ? `${clientVersion.client} ${clientVersion.version}`
                    : "Provider default"}
                </div>
              )}
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                {userAgentEditable
                  ? "Sent when the provider has no identity of its own."
                  : "Set by the provider. It cannot be changed."}
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: "10px",
                border: "1px solid var(--inner-border)",
                minWidth: 0,
              }}
            >
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
              <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginBottom: "6px" }}>
                Shared provider ceiling. One step past {SLIDER_MAX} is unlimited.
              </div>
              <Inline gap="10px" style={{ marginTop: "6px" }}>
                <input
                  id="routing-max-inflight"
                  type="range"
                  className="routing-slider"
                  data-unlimited={unlimited ? "true" : undefined}
                  min={1}
                  max={SLIDER_MAX + 1}
                  step={1}
                  value={sliderValue}
                  aria-valuetext={unlimited ? "Unlimited" : String(routing.maxInflight)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    routing.setMaxInflight(value > SLIDER_MAX ? null : Math.round(value));
                  }}
                  style={{ flex: 1, minWidth: 0, ["--slider-pct" as string]: `${(sliderValue / (SLIDER_MAX + 1)) * 100}%` }}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label="Max inflight per account"
                  value={shownValue}
                  onChange={(event) => {
                    const raw = event.target.value.trim();
                    if (raw === "" || raw === "∞") {
                      routing.setMaxInflight(null);
                      return;
                    }
                    const value = Number(raw);
                    if (Number.isFinite(value) && value >= 1)
                      routing.setMaxInflight(Math.min(MANUAL_MAX, Math.round(value)));
                  }}
                  className="form-input"
                  style={{
                    width: "52px",
                    flexShrink: 0,
                    textAlign: "center",
                    padding: "6px 4px",
                    color: unlimited ? "var(--status-success)" : undefined,
                  }}
                />
              </Inline>
            </div>
          </div>
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
