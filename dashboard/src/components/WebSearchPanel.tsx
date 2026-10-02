import { Globe, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Input } from "./ui/input";
import { Inline } from "./ui/inline";
import { Stack } from "./ui/stack";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ProviderIcon } from "./ProviderIcon";
import { useAllModelsCatalog } from "./ModelPicker";
import { useCreateProviderAccount, useProviders } from "../hooks/providers";
import { getErrorMessage } from "../shared/helpers";
import { toast } from "../shared/toast";

/**
 * Web-search providers and their connect controls, shown at the bottom of the
 * Combo & alias page.
 *
 * A web-search provider serves `POST /v1/search` (a native route, not a chat
 * wire): a caller names the provider's search model (e.g. `exa-search`) as the
 * `model`, and the gateway returns a normalized list of hits. Connecting one is
 * the same paste-a-key flow as any other API-key provider — this panel exists so
 * the operator can find the search providers, see which are connected, and read
 * the model id to call, without hunting through the full provider list.
 */
function SearchProviderRow({
  providerId,
  displayName,
  modelIds,
  initiallyConnected,
}: {
  readonly providerId: string;
  readonly displayName: string;
  readonly modelIds: readonly string[];
  readonly initiallyConnected: boolean;
}) {
  const createAccount = useCreateProviderAccount();
  const [secret, setSecret] = useState("");
  const [connected, setConnected] = useState(initiallyConnected);

  const connect = () => {
    const trimmed = secret.trim();
    if (!trimmed) return;
    createAccount.mutate(
      { providerId, request: { credentialKind: "api_key", secret: trimmed } },
      {
        onSuccess: () => {
          setConnected(true);
          setSecret("");
          toast.success(`${displayName} connected.`);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Could not save the search key.")),
      },
    );
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "12px",
        borderRadius: "10px",
        border: "1px solid var(--inner-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <ProviderIcon icon={providerId} name={displayName} size={28} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Inline gap="8px">
            <span style={{ fontSize: "13px", fontWeight: 600 }}>
              {displayName}
            </span>
            {connected ? <Badge tone="green">Connected</Badge> : null}
          </Inline>
          <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
            Call as <code>{modelIds[0] ?? `${providerId}-search`}</code> on <code>POST /v1/search</code>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Input
            label="API key"
            id={`search-key-${providerId}`}
            type="password"
            value={secret}
            placeholder="Paste the provider's search API key"
            onChange={(event) => setSecret(event.target.value)}
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={connect}
          disabled={createAccount.isPending || secret.trim().length === 0}
        >
          {createAccount.isPending ? "Saving…" : "Connect"}
        </Button>
      </div>
    </div>
  );
}

export function WebSearchPanel(): ReactNode {
  const providersQuery = useProviders();
  const catalog = useAllModelsCatalog(true);

  // A search provider is one whose catalog carries a `websearch` service-kind
  // row; the catalog is the authority, so a new search provider appears here
  // without editing this panel.
  const searchProviders = useMemo(() => {
    const byProvider = new Map<string, string[]>();
    for (const item of catalog.items) {
      if (item.entry.serviceKind !== "websearch") continue;
      const existing = byProvider.get(item.providerId) ?? [];
      existing.push(item.modelId);
      byProvider.set(item.providerId, existing);
    }
    return byProvider;
  }, [catalog.items]);

  const connected = useMemo(() => {
    const set = new Set<string>();
    for (const provider of providersQuery.data ?? []) {
      if (provider.configured) set.add(provider.providerId.toLowerCase());
    }
    return set;
  }, [providersQuery.data]);

  const entries = useMemo(
    () => [...searchProviders.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [searchProviders],
  );

  if (providersQuery.isPending || catalog.isLoading)
    return <LoadingState label="Loading web search providers…" />;
  if (providersQuery.isError || catalog.isError) {
    return (
      <ErrorState
        message={getErrorMessage(providersQuery.error, "Failed to load web search providers")}
        onRetry={() => {
          void providersQuery.refetch();
          catalog.refetch();
        }}
      />
    );
  }

  return (
    <Card>
      <CardHeader
        title="Web Search"
        subtitle="Dedicated search APIs behind POST /v1/search"
        icon={<Search size={16} />}
      />
      <CardBody>
        {entries.length === 0 ? (
          <EmptyState
            title="No search providers available"
            message="Bundled web-search providers appear here once their catalog is loaded."
          />
        ) : (
          <Stack gap="12px">
            {entries.map(([providerId, modelIds]) => (
              <SearchProviderRow
                key={providerId}
                providerId={providerId}
                displayName={providersQuery.data.find((provider) => provider.providerId === providerId)?.displayName ?? providerId}
                modelIds={modelIds}
                initiallyConnected={connected.has(providerId.toLowerCase())}
              />
            ))}
            <p style={{ fontSize: "11px", color: "var(--text-tertiary)", display: "flex", gap: "6px" }}>
              <Globe size={13} style={{ flexShrink: 0, marginTop: "1px" }} />
              <span>
                Send <code>{`{ "model": "<provider>-search", "query": "…", "max_results": 5 }`}</code>{" "}
                to <code>POST /v1/search</code>. Search providers can also be combined through a combo
                for failover across several search backends.
              </span>
            </p>
          </Stack>
        )}
      </CardBody>
    </Card>
  );
}
