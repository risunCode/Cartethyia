import { ShieldOff, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { DataTable } from "./ui/layout";
import { Inline } from "./ui/inline";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import type { ModelAbuseBan } from "../data/contracts";
import { useModelBans, useUnbanModel } from "../hooks/model-bans";

/**
 * The model-abuse ban list, opened from the API Credentials header.
 *
 * A ban is keyed on the client address, so it is cross-tenant and only a
 * platform admin may see or lift one; the panel that hosts this dialog hides
 * the entry point for everyone else. A ban lapses on its own after its TTL —
 * lifting one early is the escape hatch for a false positive (a shared NAT, a
 * client that genuinely mistyped a model id).
 */
function lapseLabel(expiresAt: number): string {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return "—";
  const remaining = expiresAt - Date.now();
  const absolute = date.toLocaleString();
  if (remaining <= 0) return `${absolute} (lapsed)`;
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${absolute} (in ${totalMinutes}m)`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${absolute} (in ${hours}h)`;
  return `${absolute} (in ${Math.floor(hours / 24)}d)`;
}

export function ModelBansDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const bansQuery = useModelBans(true);
  const unban = useUnbanModel();
  const [unbanTarget, setUnbanTarget] = useState<ModelAbuseBan | null>(null);
  const bans = bansQuery.data ?? [];

  return (
    <>
      <Dialog
        open={true}
        onClose={onClose}
        title="Banned Users"
        description="Client addresses banned for repeated invalid-model requests. Lifting a ban lets the address reach the gateway again."
        size="lg"
      >
        <div className="flex flex-col gap-7 min-w-0">
          <div className="min-w-0">
            <h4
              className="text-caption font-semibold text-text-secondary mb-4"
            >
              Active bans ({bans.length})
            </h4>
            {bansQuery.isPending ? (
              <LoadingState label="Loading banned users…" />
            ) : bansQuery.isError ? (
              <ErrorState
                message={getErrorMessage(bansQuery.error, "Could not load banned users.")}
                onRetry={() => void bansQuery.refetch()}
              />
            ) : bans.length === 0 ? (
              <EmptyState
                title="No banned users"
                message="No client address is currently banned for model abuse."
                icon={<ShieldOff size={20} />}
              />
            ) : (
              <div className="rounded-inset border border-inner-border">
                <DataTable maxHeight={480} scrollRegion headers={["Client IP", "Lapses", ""]}>
                  {bans.map((ban) => (
                    <tr key={ban.ip}>
                      <td className="font-mono tabular-nums text-badge text-text-primary whitespace-nowrap">
                        {ban.ip}
                      </td>
                      <td
                        className="text-badge text-text-secondary whitespace-nowrap"
                      >
                        {lapseLabel(ban.expiresAt)}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Undo2 size={13} />}
                          disabled={unban.isPending}
                          onClick={() => setUnbanTarget(ban)}
                        >
                          Unban
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              </div>
            )}
          </div>

          <Inline justify="flex-end" gap="0px">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </Inline>
        </div>
      </Dialog>

      <ConfirmDialog
        open={unbanTarget !== null}
        onClose={() => setUnbanTarget(null)}
        onConfirm={async () => {
          if (!unbanTarget) return;
          await unban.mutateAsync(unbanTarget.ip);
          toast.success(`Unbanned ${unbanTarget.ip}.`);
          setUnbanTarget(null);
        }}
        title="Lift this ban?"
        message={
          unbanTarget
            ? `Lift the ban on ${unbanTarget.ip}? The address can reach the gateway again immediately.`
            : "Lift this ban?"
        }
        confirmLabel="Unban"
        danger
      />
    </>
  );
}
