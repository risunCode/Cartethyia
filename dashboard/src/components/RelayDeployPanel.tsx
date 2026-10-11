import { Server, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Stack } from "./ui/stack";
import {
  DEFAULT_RELAY_REGION,
  RELAY_REGION_GROUPS,
  RELAY_TARGETS,
  type RelayRegion,
  type RelayTarget,
} from "../data/contracts";
import { useDeployRelay } from "../hooks/network";
import { getErrorMessage } from "../data/api";
import { toast } from "../lib/toast";

/** Human labels and per-target fields for the deploy form. */
const TARGET_META: Record<
  RelayTarget,
  {
    readonly label: string;
    readonly tokenLabel: string;
    readonly needsAccount: boolean;
    readonly host: string;
    /** Whether traffic leaves from a country the operator picks. */
    readonly hasRegion: boolean;
  }
> = {
  cloudflare: {
    label: "Cloudflare Workers",
    tokenLabel: "Cloudflare API token",
    needsAccount: true,
    host: "*.workers.dev",
    // Workers runs at the edge nearest the caller, not in a chosen region, so
    // offering a country picker here would be a control that does nothing.
    hasRegion: false,
  },
  vercel: {
    label: "Vercel",
    tokenLabel: "Vercel API token",
    needsAccount: false,
    host: "*.vercel.app",
    hasRegion: true,
  },
  deno: {
    label: "Deno Deploy",
    tokenLabel: "Deno Deploy token",
    needsAccount: false,
    host: "*.deno.dev",
    hasRegion: false,
  },
};

/** Flat options for the region picker; the group name leads each label. */
const REGION_OPTIONS = RELAY_REGION_GROUPS.flatMap((group) =>
  group.regions.map((entry) => ({ value: entry.id, label: `${group.label} — ${entry.label}` })),
);

/**
 * Deploy a hosted relay (Cloudflare Workers / Vercel / Deno Deploy) and register
 * it as an outbound network pool.
 *
 * The deployed worker forwards requests to the origin named by
 * `x-relay-target` — the exact contract the pool dispatcher already speaks for
 * `*.workers.dev` / `*.vercel.app` / `*.deno.dev` hosts — so a deployed relay
 * becomes an ordinary HTTP pool with no manual wiring. The provider API token is
 * used for the deploy and never stored; only the public relay URL is persisted.
 *
 * Rendered as a modal launched from the Proxy Pool header, so it lives with the
 * pools it creates rather than as a separate always-on card.
 */
export function RelayDeployModal({
  onClose,
}: {
  readonly onClose: () => void;
}): ReactNode {
  const deploy = useDeployRelay();
  const [target, setTarget] = useState<RelayTarget>("cloudflare");
  const [region, setRegion] = useState<RelayRegion>(DEFAULT_RELAY_REGION);
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  const meta = TARGET_META[target];
  const canSubmit =
    token.trim().length > 0 && (!meta.needsAccount || accountId.trim().length > 0);

  const submit = () => {
    if (!canSubmit) return;
    deploy.mutate(
      {
        target,
        token: token.trim(),
        ...(meta.needsAccount && accountId.trim() ? { accountId: accountId.trim() } : {}),
        ...(projectName.trim() ? { projectName: projectName.trim() } : {}),
        // Only Vercel runs in a region an operator chooses; sending it to the
        // others would be a control that does nothing.
        ...(meta.hasRegion ? { region } : {}),
      },
      {
        onSuccess: (result) => {
          setLastUrl(result.relayUrl);
          setToken("");
          toast.success(`Relay deployed to ${result.relayUrl} and registered as a pool.`);
        },
        onError: (error) => toast.error(getErrorMessage(error, "Relay deploy failed.")),
      },
    );
  };

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="Deploy Relay"
      description="Run outbound traffic through a hosted relay (Cloudflare, Vercel, Deno)."
      size="md"
    >
      <Stack gap="12px">
        <p className="text-badge text-text-tertiary m-0 flex gap-3">
          <Server size={13} className="shrink-0 mt-0.5" />
          <span>
            Deploys a small relay worker to your own {meta.label} account and registers its URL
            (<code>{meta.host}</code>) as an active HTTP pool. Your API token is used only for the
            deploy and is never stored.
          </span>
        </p>
        <Select
          label="Relay host"
          id="relay-target"
          value={target}
          onValueChange={(value) => setTarget(value as RelayTarget)}
          options={RELAY_TARGETS.map((id) => ({ value: id, label: TARGET_META[id].label }))}
        />
        <Input
          label={meta.tokenLabel}
          id="relay-token"
          type="password"
          value={token}
          placeholder="Paste a deploy token"
          onChange={(event) => setToken(event.target.value)}
        />
        {meta.needsAccount ? (
          <Input
            label="Account ID"
            id="relay-account"
            value={accountId}
            placeholder="Cloudflare account id"
            onChange={(event) => setAccountId(event.target.value)}
          />
        ) : null}
        <Input
          label="Project name (optional)"
          id="relay-project"
          value={projectName}
          placeholder="e.g. cartethyia-relay"
          onChange={(event) => setProjectName(event.target.value)}
        />
        {meta.hasRegion ? (
          <Select
            label="Deploy region"
            id="relay-region"
            value={region}
            onValueChange={(value) => setRegion(value as RelayRegion)}
            options={REGION_OPTIONS}
          />
        ) : null}
        {meta.hasRegion ? (
          <p className="text-badge text-text-tertiary m-0">
            Sets the region on the Vercel project, which is what decides the country
            outbound traffic leaves from. A region sent on the deployment alone is
            accepted but does not move the Function.
          </p>
        ) : null}
        <div className="flex items-center gap-5">
          <Button variant="primary" size="sm" onClick={submit} disabled={!canSubmit || deploy.isPending}>
            {deploy.isPending ? "Deploying…" : "Deploy relay"}
          </Button>
          {lastUrl ? (
            <span className="mt-1 text-badge text-text-tertiary">
              Registered pool at <code>{lastUrl}</code>
            </span>
          ) : null}
        </div>
        {deploy.isError ? (
          <p className="text-badge text-red m-0 flex gap-3">
            <TriangleAlert size={13} className="shrink-0 mt-0.5" />
            <span>{getErrorMessage(deploy.error, "Relay deploy failed.")}</span>
          </p>
        ) : null}
      </Stack>
    </Dialog>
  );
}
