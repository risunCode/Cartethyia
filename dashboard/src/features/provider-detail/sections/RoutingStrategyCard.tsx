import { Cable, ChevronDown, Fingerprint, Gauge, Info, Layers, RefreshCw, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Inline } from "../../../components/ui/inline";
import { ListRow } from "../../../components/ui/list-row";
import { Select } from "../../../components/ui/select";
import { ErrorState, LoadingState } from "../../../components/ui/state";
import { Switch } from "../../../components/ui/switch";
import { toast } from "../../../lib/toast";
import { DASHBOARD_VERSION } from "../../../lib/version";
import {
  PROXY_SKIP_HINT_PROVIDERS,
  ROUTING_ACTIVE_LABEL,
  useRoutingStrategy,
} from "../../../hooks/use-routing-strategy";

/** The slider's own scale: 1–50, with one step past the end meaning unlimited. */
const SLIDER_MAX = 50;
/** A typed number may go past the slider, but not past this. */
const MANUAL_MAX = 100;
function userAgentPresets(cartethyiaVersion: string, codexVersion: string, claudeVersion: string) {
  return [
    { value: "", label: "None" },
    { value: `Cartethyia/${cartethyiaVersion}`, label: `Cartethyia ${cartethyiaVersion}` },
    { value: `codex_cli_rs/${codexVersion}`, label: "Codex" },
    { value: `claude-cli/${claudeVersion} (external, cli)`, label: "Claude Code" },
  ] as const;
}

/** Shared shell for the grouped settings rows. */
function Row({ children, action }: { readonly children: ReactNode; readonly action: ReactNode }): ReactNode {
  return <ListRow actions={action}>{children}</ListRow>;
}

export function RoutingStrategyCard({
  providerId,
  clientVersion,
  routeIdentityVersions,
  userAgentEditable,
}: {
  readonly providerId: string;
  /** The provider's own discovered client, shown when its identity is fixed. */
  readonly clientVersion?: { readonly client: string; readonly version: string };
  readonly routeIdentityVersions: { readonly codex: string; readonly claude: string };
  /** False when the provider stamps its own identity, so the shown value cannot be changed. */
  readonly userAgentEditable: boolean;
}): ReactNode {
  const routing = useRoutingStrategy(providerId, userAgentEditable);
  const showUnsupportedHint = PROXY_SKIP_HINT_PROVIDERS.has(providerId);
  const presets = userAgentPresets(
    DASHBOARD_VERSION,
    routeIdentityVersions.codex,
    routeIdentityVersions.claude,
  );
  const userAgentOptions = presets.some((option) => option.value === routing.userAgent)
    ? presets
    : [...presets, { value: routing.userAgent, label: "Custom" }];

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
        <div className="grid gap-5 w-full min-w-0">
          <Row
            action={
              <Switch
                checked={routing.roundRobinEnabled}
                onChange={routing.setRoundRobinEnabled}
                id="routing-round-robin"
              />
            }
          >
            <div className="min-w-0">
              <label htmlFor="routing-round-robin">
                <Inline gap="6px" className="text-body font-semibold">
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
              <div className="mt-1 text-badge text-text-tertiary">
                Off = failover: use accounts in priority order, fall through on failure. On = rotate
                requests across this provider's accounts.
              </div>
            </div>
          </Row>

          {routing.roundRobinEnabled ? (
            <Row
              action={
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
                  className="form-input w-36 shrink-0 text-center px-4 py-3"
                />
              }
            >
              <div className="min-w-0">
                <label htmlFor="routing-rotate-count">
                  <Inline gap="6px" className="text-body font-semibold">
                    <RefreshCw
                      size={15}
                      aria-hidden="true"
                      className="text-text-tertiary shrink-0"
                    />
                    Accounts per rotation
                  </Inline>
                </label>
                <div className="mt-1 text-badge text-text-tertiary">
                  Requests served before the rotation advances
                </div>
              </div>
            </Row>
          ) : null}

          <Row
            action={
              <Switch
                checked={routing.skipProxy}
                onChange={routing.setSkipProxy}
                id="routing-skip-proxy"
              />
            }
          >
            <div className="min-w-0">
              <label htmlFor="routing-skip-proxy">
                <Inline gap="6px" className="text-body font-semibold">
                  <Cable
                    size={15}
                    aria-hidden="true"
                    style={{
                      color: routing.skipProxy ? "var(--accent)" : "var(--text-tertiary)",
                      flexShrink: 0,
                    }}
                  />
                  Always direct
                </Inline>
              </label>
              <div className="mt-1 text-badge text-text-tertiary">
                Bypass automatic proxy-pool routing for this provider and always dial direct
              </div>
            </div>
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
              className="px-6 py-5 rounded-control border border-inner-border min-w-0"
            >
              <Inline gap="6px" className="text-body font-semibold mb-3">
                <Fingerprint
                  size={15}
                  aria-hidden="true"
                  className="text-text-tertiary shrink-0"
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
                <div aria-label="Client identity" className="radix-select-trigger" aria-disabled="true">
                  <span>
                    {clientVersion
                      ? `${clientVersion.client} ${clientVersion.version}`
                      : "Provider default"}
                  </span>
                  <ChevronDown size={14} aria-hidden="true" />
                </div>
              )}
              <div className="text-badge text-text-tertiary mt-2">
                {userAgentEditable
                  ? "Sent when the provider has no identity of its own."
                  : "Set by the provider. It cannot be changed."}
              </div>
            </div>

            <div
              className="px-6 py-5 rounded-control border border-inner-border min-w-0"
            >
              <label htmlFor="routing-max-inflight" className="form-label">
                <Inline gap="6px" className="text-body font-semibold">
                  <Gauge
                    size={15}
                    aria-hidden="true"
                    className="text-text-tertiary shrink-0"
                  />
                  Max inflight / account
                </Inline>
              </label>
              <div className="text-badge text-text-tertiary mb-3">
                Shared provider ceiling. One step past {SLIDER_MAX} is unlimited.
              </div>
              <Inline gap="10px" className="mt-3">
                <input
                  id="routing-max-inflight"
                  type="range"
                  className="routing-slider flex-1 min-w-0"
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
                  style={{ ["--slider-pct" as string]: `${(sliderValue / (SLIDER_MAX + 1)) * 100}%` }}
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
              className="mt-1 text-badge text-text-tertiary"
            >
              <Info size={12} className="shrink-0 mt-0.5" />
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
