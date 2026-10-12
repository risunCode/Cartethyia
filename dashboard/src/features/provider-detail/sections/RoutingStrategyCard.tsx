import { Cable, Fingerprint, Gauge, Info, Layers, Minus, Plus, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
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
} from "../../../hooks/routing-strategy";

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
  const adjustRotateCount = (delta: number) => {
    routing.setRotateCount(Math.min(1000, Math.max(1, routing.rotateCount + delta)));
  };
  const handleUserAgentChange = (next: string) => {
    if (next === routing.userAgent) return;
    routing.setUserAgent(next);
    const label = userAgentOptions.find((option) => option.value === next)?.label ?? next;
    toast.success("Client identity updated", label);
  };

  // The provider's own discovered client, shown verbatim when its identity is
  // fixed — the same string the editable path lists as a preset.
  const fixedIdentity = clientVersion
    ? `${clientVersion.client} ${clientVersion.version}`
    : "Provider default";

  return (
    <Card>
      <CardHeader title="Routing Strategy" subtitle={subtitle} icon={<Layers size={16} />} />
      <CardBody>
        <div className="grid gap-5 w-full min-w-0">
          <Row
            action={
              <>
                {routing.roundRobinEnabled ? (
                  <div
                    role="group"
                    aria-label="Accounts per rotation"
                    className="inline-flex items-center gap-1 rounded-control border border-inner-border bg-surface-1 p-1"
                  >
                    <span className="px-2 text-badge text-text-secondary">Accounts/rotation</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 rounded-tiny"
                      aria-label="Decrease accounts per rotation"
                      disabled={routing.rotateCount <= 1}
                      icon={<Minus size={14} />}
                      onClick={() => adjustRotateCount(-1)}
                    />
                    <output
                      className="min-w-8 text-center text-body font-semibold tabular-nums"
                      aria-live="polite"
                    >
                      {routing.rotateCount}
                    </output>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 rounded-tiny"
                      aria-label="Increase accounts per rotation"
                      disabled={routing.rotateCount >= 1000}
                      icon={<Plus size={14} />}
                      onClick={() => adjustRotateCount(1)}
                    />
                  </div>
                ) : null}
                <Switch
                  checked={routing.roundRobinEnabled}
                  onChange={routing.setRoundRobinEnabled}
                  id="routing-round-robin"
                />
              </>
            }
          >
            <div className="min-w-0">
              <label htmlFor="routing-round-robin">
                <Inline gap="6px" className="text-body font-semibold">
                  <Repeat
                    size={15}
                    aria-hidden="true"
                    className={`shrink-0 ${routing.roundRobinEnabled ? "text-accent" : "text-text-tertiary"}`}
                  />
                  Round robin
                </Inline>
              </label>
              <div className="mt-1 text-badge text-text-tertiary">
                Off uses priority order with failover. On rotates requests across this provider's
                accounts.
              </div>
            </div>
          </Row>

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
                    className={`shrink-0 ${routing.skipProxy ? "text-accent" : "text-text-tertiary"}`}
                  />
                  Always direct
                </Inline>
              </label>
              <div className="mt-1 text-badge text-text-tertiary">
                Bypass automatic proxy-pool routing for this provider and always dial direct
              </div>
            </div>
          </Row>

          {/* Two panels side by side while there is room; the auto-fit track is a
              card-width question, so it stays in CSS rather than an arbitrary
              utility. */}
          <div className="provider-grid grid gap-5 min-w-0">
            <div
              className="px-6 py-5 rounded-control border border-inner-border bg-surface-2 min-w-0"
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
                // A real disabled `Select`, not a hand-built trigger. The fake one
                // carried the `radix-select-trigger` marker with none of the
                // utilities the real trigger owns, so the value and its chevron
                // stacked as loose text instead of reading as a control.
                <Select
                  id="routing-user-agent-fixed"
                  aria-label="Client identity"
                  disabled
                  value={fixedIdentity}
                  options={[{ value: fixedIdentity, label: fixedIdentity }]}
                />
              )}
              <div className="text-badge text-text-tertiary mt-2">
                {userAgentEditable
                  ? "Sent when the provider has no identity of its own."
                  : "Set by the provider. It cannot be changed."}
              </div>
            </div>

            <div
              className="px-6 py-5 rounded-control border border-inner-border bg-surface-2 min-w-0"
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
                  className={`form-input w-26 shrink-0 px-2 py-3 text-center text-body ${unlimited ? "text-status-success" : ""}`}
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
