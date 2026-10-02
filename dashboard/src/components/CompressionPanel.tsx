import { Minimize2, Scissors, Sparkles, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Select } from "./ui/select";
import { Switch } from "./ui/switch";
import { Inline } from "./ui/inline";
import { Stack } from "./ui/stack";
import { ErrorState, LoadingState } from "./ui/state";
import { toast } from "../shared/toast";
import { getErrorMessage } from "../shared/helpers";
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
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", gap: "10px", minWidth: 0 }}>
              <Scissors size={16} style={{ flexShrink: 0, marginTop: "2px", color: "var(--text-secondary)" }} />
              <div style={{ minWidth: 0 }}>
                <label htmlFor="compression-rtk">
                  <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                    Prune tool output (RTK)
                  </Inline>
                </label>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Compact bulky tool results (diffs, grep dumps, listings) in the message history so a
                  long conversation stops re-sending megabytes of raw output. Higher strength compresses
                  more aggressively.
                </div>
              </div>
            </div>
            <Inline gap="8px" style={{ flexShrink: 0, alignItems: "center" }}>
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
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", gap: "10px", minWidth: 0 }}>
              <Sparkles size={16} style={{ flexShrink: 0, marginTop: "2px", color: "var(--text-secondary)" }} />
              <div style={{ minWidth: 0 }}>
                <label htmlFor="compression-ponytail">
                  <Inline gap="6px" style={{ fontSize: "13px", fontWeight: 600 }}>
                    PonyTail (system directive)
                  </Inline>
                </label>
                <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
                  Appends a minimal-code directive to the system content, biasing the model toward the
                  smallest working change. Higher strength pushes harder toward deletion over addition.
                </div>
              </div>
            </div>
            <Inline gap="8px" style={{ flexShrink: 0, alignItems: "center" }}>
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
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "flex-start",
                margin: 0,
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid var(--orange)",
                background: "var(--orange-soft)",
                color: "var(--text-secondary)",
                fontSize: "11px",
              }}
            >
              <TriangleAlert size={14} style={{ flexShrink: 0, marginTop: "1px", color: "var(--orange)" }} />
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
