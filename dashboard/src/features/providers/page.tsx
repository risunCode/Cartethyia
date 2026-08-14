/** Providers page — daemon catalog and operator-safe account controls. */

import { ChevronDown } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { daemonFailure } from "../../lib/daemon-api";
import { StatusDot } from "../../components/status-dot";
import { ProviderIcon } from "../../components/provider-icon";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { StatePanel } from "../../components/ui/state";
import { useProviders } from "../../components/model-picker";

interface ProviderInfo {
  id: string;
  name: string;
  icon: string;
  authKind: "none" | "session" | "oauth" | "api-key";
  prefix: string;
  modelCount: number;
  capabilityCounts: {
    chat: number;
    media: number;
    websearch: number;
  };
  status: "ok" | "warn";
  connections: number;
  supportsOAuth: boolean;
  supportsApiKey: boolean;
}

type ProviderCapability = keyof ProviderInfo["capabilityCounts"];

const PROVIDER_CAPABILITIES: readonly { value: ProviderCapability; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "media", label: "Image / Video" },
  { value: "websearch", label: "Web Search" },
];
function providerCapabilityFromSearch(search: string): ProviderCapability {
  const requested = new URLSearchParams(search).get("capability");
  return requested === "media" || requested === "websearch" ? requested : "chat";
}

/** Display order for built-in providers: free limited, OAuth, then API key/PAT. */
const SECTIONS: { authKinds: ProviderInfo["authKind"][]; title: string }[] = [
  { authKinds: ["none"], title: "Free Limited Providers" },
  { authKinds: ["session", "oauth"], title: "OAuth Providers" },
  { authKinds: ["api-key"], title: "API Key Providers" },
];

// ── Custom Providers (OpenAI/Anthropic Compatible) ──────────────────────



function CustomProvidersSection() {
  return (
    <StatePanel
      kind="degraded"
      title="Custom provider catalog unavailable"
      description="The daemon has not advertised a custom-provider catalog contract. No endpoint credentials are retained in dashboard state."
    />
  );
}

/** Credential state shown under the provider name. */
function StatusLine({ provider }: { provider: ProviderInfo }) {
  if (provider.authKind === "none") return <Badge tone="ok">Ready</Badge>;
  if (provider.connections === 0) return <Badge>No connections</Badge>;
  return (
    <Badge tone="ok" className="gap-1.5">
      <StatusDot status="ok" />
      {provider.connections} Connected
    </Badge>
  );
}

const ProviderCard = memo(function ProviderCard({ provider, capability }: { provider: ProviderInfo; capability: ProviderCapability }) {
  return (
    <Card className="p-3 transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-lg">
      <Link to={`/providers/${provider.id}?capability=${encodeURIComponent(capability)}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        <div className="flex items-center gap-2.5">
          <ProviderIcon icon={provider.icon} name={provider.name} size={32} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{provider.name}</span>
              {provider.status === "warn" && <StatusDot status="warn" />}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusLine provider={provider} />

            </div>
          </div>
          <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
            <span className="rounded-md bg-[var(--kbd-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--text-3)]">
              {provider.prefix}/
            </span>
            <Badge tone="info">{provider.modelCount} models</Badge>
          </div>
        </div>
      </Link>

      </Card>
  );
});

export function ProvidersPage() {
  const location = useLocation();
  const { data, isLoading, isFetching, isError, error, refetch } = useProviders();
  const [capability, setCapability] = useState<ProviderCapability>(() => providerCapabilityFromSearch(location.search));
  const items: ProviderInfo[] = (data?.items ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    icon: provider.icon,
    authKind: (provider.credentialKind === "api_key" ? "api-key" : provider.credentialKind === "manual" ? "none" : provider.credentialKind ?? "none") as ProviderInfo["authKind"],
    prefix: provider.prefix,
    modelCount: provider.modelCount,
    capabilityCounts: provider.capabilityCounts ?? { chat: provider.modelCount, media: 0, websearch: 0 },
    status: (provider.enabled !== false && (provider.credentialKind === "manual" || provider.credentialKind === "none" || provider.configured === true) ? "ok" : "warn") as ProviderInfo["status"],
    connections: provider.connections,
    supportsOAuth: provider.credentialKinds?.includes("oauth") ?? provider.credentialKind === "oauth",
    supportsApiKey: provider.credentialKinds?.includes("api_key") ?? provider.credentialKind === "api_key",
  }));
  const registryLoading = isLoading || (isFetching && items.length === 0);
  const capabilityLabel = PROVIDER_CAPABILITIES.find((option) => option.value === capability)?.label ?? "Chat";
  const capabilityItems = items
    .filter((provider) => provider.capabilityCounts[capability] > 0)
    .map((provider) => ({ ...provider, modelCount: provider.capabilityCounts[capability] }));

  const sections = SECTIONS.map((section) => ({
    ...section,
    providers: capabilityItems
      .filter((provider) => section.authKinds.includes(provider.authKind))
      .sort((left, right) => right.connections - left.connections || left.name.localeCompare(right.name)),
  })).filter((section) => section.providers.length > 0);

  const [visibleCount, setVisibleCount] = useState(12);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const totalProviders = sections.reduce((total, section) => total + section.providers.length, 0);
  const visibleProviders = sections.reduce((total, section) => total + Math.min(visibleCount, section.providers.length), 0);
  const hasMore = visibleProviders < totalProviders;

  useEffect(() => {
    if (!hasMore) return;
    const target = loadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisibleCount((current) => current + 12);
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore]);

  return (
    <div className="dashboard-page space-y-4">
      {registryLoading ? (
        <StatePanel kind="loading" title="Loading providers" description="Reading the provider registry…" />
      ) : isError && items.length === 0 ? (
        <StatePanel
          kind={daemonFailure(error).degraded ? "degraded" : "error"}
          title={daemonFailure(error).degraded ? "Provider catalog degraded" : "Failed to load providers"}
          description={`${daemonFailure(error).message} (${daemonFailure(error).code})`}
          action={<Button variant="secondary" onClick={() => void refetch()}>Retry</Button>}
        />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-col gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/55 px-4 py-3 backdrop-blur-xl lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <label htmlFor="provider-capability" className="text-xs font-semibold uppercase tracking-wider text-[var(--text-3)]">Provider capability</label>
              <p className="mt-1 text-xs text-[var(--text-3)]">Showing providers with models that support {capabilityLabel.toLowerCase()}.</p>
            </div>
            <div className="relative w-full shrink-0 lg:w-64">
              <select
                id="provider-capability"
                value={capability}
                onChange={(event) => {
                  setCapability(event.target.value as ProviderCapability);
                  setVisibleCount(12);
                }}
                className="h-10 w-full appearance-none rounded-lg border border-[var(--inner-border)] bg-[var(--glass-bg-2)] px-3 pr-9 text-sm font-medium text-[var(--text-1)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/30"
              >
                {PROVIDER_CAPABILITIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <ChevronDown size={15} aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            </div>
          </div>
          {capability === "chat" && <CustomProvidersSection />}
          {sections.length === 0 ? (
            <StatePanel kind="empty" title={`No ${capabilityLabel} providers`} description="No configured models currently advertise this capability." />
          ) : sections.map((section) => (
            <section key={section.title} className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold tracking-tight">{section.title} ({section.providers.length})</h2>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {section.providers.slice(0, visibleCount).map((provider) => (
                  <div key={provider.id} className="min-w-0 [contain-intrinsic-size:160px] [content-visibility:auto]">
                    <ProviderCard provider={provider} capability={capability} />
                  </div>
                ))}
              </div>
            </section>
          ))}
          {totalProviders > 0 && (
            <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)]/55 px-4 py-2 text-center text-[11px] text-[var(--text-3)] backdrop-blur-xl">
              {hasMore ? `Showing ${visibleProviders} of ${totalProviders} providers · loading more as you scroll` : `Showing all ${totalProviders} providers`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
