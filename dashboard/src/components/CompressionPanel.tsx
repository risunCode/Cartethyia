import { Minimize2, Scissors, Sparkles, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Select } from "./ui/select";
import { Switch } from "./ui/switch";
import { Inline } from "./ui/inline";
import { Stack } from "./ui/stack";
import { ErrorState, LoadingState } from "./ui/state";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../hooks/settings";

/**
 * Request-compression controls (RTK prune + PonyTail), shown on the Overview
 * page above the API keys. Both are off by default and per-tenant. They reshape
 * the canonical request before dispatch: RTK prune compacts bulky tool-result
 * text, PonyTail appends a minimal-code directive to the system content.
 *
 * Each control is a strength dropdown with an enable toggle beside it. Both
 * transforms rewrite what the model sees, so the card carries a quality notice:
 * on, they can cost output quality — the trade is fewer tokens for a chance the
 * model reasons on less context.
 */
export function CompressionPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending) return <LoadingState label="Loading compression settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(query.error, "Failed to load compression settings")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const rtkOn = settings.rtkPruneEnabled;
  const ponyOn = settings.ponyTailEnabled;

  return (
    <Card>
      <CardHeader
        title="Compression"
        subtitle="Shrink requests before they reach the provider"
        icon={<Minimize2 size={16} />}
      />
      <CardBody>
        <Stack gap="14px">
          {/* Prune tool output (RTK): a strength dropdown, then the enable
              toggle. The dropdown stays usable while off so the operator can
              pick a strength before switching it on. */}
          <div
            className="flex items-start gap-x-8 gap-y-5"
          >
            <div className="flex gap-5 min-w-0 flex-auto">
              <Scissors size={16} className="shrink-0 mt-1 text-text-secondary" />
              <div className="min-w-0">
                <label htmlFor="compression-rtk">
                  <Inline gap="6px" className="text-body font-semibold">
                    Prune tool output (RTK)
                  </Inline>
                </label>
                <div className="text-badge text-text-tertiary wrap-anywhere max-w-full">
                  Compact bulky tool results (diffs, grep dumps, listings) in the message history so a
                  long conversation stops re-sending megabytes of raw output. Higher strength compresses
                  more aggressively.
                </div>
              </div>
            </div>
            <Inline gap="8px" className="shrink-0 items-center ml-auto">
              <Select
                id="compression-rtk-level"
                aria-label="RTK strength"
                value={settings.rtkPruneLevel}
                onValueChange={(value) =>
                  mutation.mutate(
                    {
                      rtkPruneLevel:
                        value === "lite" || value === "full" || value === "ultra" ? value : "full",
                    },
                    {
                      onError: (error) =>
                        toast.error(getErrorMessage(error, "Could not update RTK strength.")),
                    },
                  )
                }
                options={[
                  { value: "lite", label: "Lite" },
                  { value: "full", label: "Full" },
                  { value: "ultra", label: "Ultra" },
                ]}
              />
              <Switch
                id="compression-rtk"
                aria-label="Enable RTK prune"
                checked={rtkOn}
                onChange={(next) =>
                  mutation.mutate(
                    { rtkPruneEnabled: next },
                    {
                      onError: (error) =>
                        toast.error(getErrorMessage(error, "Could not update RTK prune.")),
                    },
                  )
                }
              />
            </Inline>
          </div>

          {/* PonyTail (system directive): same shape — strength dropdown + toggle. */}
          <div
            className="flex items-start gap-x-8 gap-y-5"
          >
            <div className="flex gap-5 min-w-0 flex-auto">
              <Sparkles size={16} className="shrink-0 mt-1 text-text-secondary" />
              <div className="min-w-0">
                <label htmlFor="compression-ponytail">
                  <Inline gap="6px" className="text-body font-semibold">
                    PonyTail (system directive)
                  </Inline>
                </label>
                <div className="text-badge text-text-tertiary wrap-anywhere max-w-full">
                  Appends a minimal-code directive to the system content, biasing the model toward the
                  smallest working change. Higher strength pushes harder toward deletion over addition.
                </div>
              </div>
            </div>
            <Inline gap="8px" className="shrink-0 items-center ml-auto">
              <Select
                id="compression-ponytail-level"
                aria-label="PonyTail strength"
                value={settings.ponyTailLevel}
                onValueChange={(value) =>
                  mutation.mutate(
                    {
                      ponyTailLevel:
                        value === "lite" || value === "full" || value === "ultra" ? value : "full",
                    },
                    {
                      onError: (error) =>
                        toast.error(getErrorMessage(error, "Could not update PonyTail strength.")),
                    },
                  )
                }
                options={[
                  { value: "lite", label: "Lite" },
                  { value: "full", label: "Full" },
                  { value: "ultra", label: "Ultra" },
                ]}
              />
              <Switch
                id="compression-ponytail"
                aria-label="Enable PonyTail"
                checked={ponyOn}
                onChange={(next) =>
                  mutation.mutate(
                    { ponyTailEnabled: next },
                    {
                      onError: (error) =>
                        toast.error(getErrorMessage(error, "Could not update PonyTail.")),
                    },
                  )
                }
              />
            </Inline>
          </div>

          {rtkOn || ponyOn ? (
            <p
              role="note"
              className="flex gap-4 items-start m-0 py-4 px-5 rounded-inset border border-orange bg-orange-soft text-text-secondary text-badge"
            >
              <TriangleAlert size={14} className="shrink-0 mt-0.5 text-orange" />
              <span>
                Your AI may produce degraded quality while compression is active: it sees a
                shortened history and a minimal-code directive, so fewer tokens but a chance of
                missing detail. Turn it off if answers get worse.
              </span>
            </p>
          ) : null}
        </Stack>
      </CardBody>
    </Card>
  );
}
