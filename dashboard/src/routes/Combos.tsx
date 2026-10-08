import { ArrowRight, Copy, CopyPlus, GripVertical, Layers, Pencil, Plus, Route, Search, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Inline } from "../components/ui/inline";
import { ModelPickerModal } from "../components/ModelPicker";
import { SortableList } from "../components/SortableList";
import { Stack } from "../components/ui/stack";
import { getErrorMessage } from "../shared/helpers";
import { useTrackedTimeout } from "../hooks/use-timeout";
import { useClipboard } from "../hooks/use-clipboard";
import { toast } from "../shared/toast";
import type { ComboStrategy, ModelAliasRow, ModelComboRow } from "../data/contracts";
import { COMBO_STRATEGY_OPTIONS } from "../shared/combo-strategy";
import {
  useCloneModelCombo,
  useCreateModelAlias,
  useCreateModelCombo,
  useDeleteModelAlias,
  useDeleteModelCombo,
  useModelAliases,
  useModelCombos,
  useReorderModelAliases,
  useReorderModelCombos,
  useUpdateModelAlias,
  useUpdateModelCombo,
} from "../hooks/routing";

/** A stable id for a chip in the dialog's SortableList. Browser sessions need
 *  not be unique across page lifetime — they only need to survive one drag. */
const makeId = (): string =>
  `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── Aliases Section ──────────────────────────────────────────────────────────

function AliasesSection(): ReactNode {
  const aliasesQuery = useModelAliases();
  const createMutation = useCreateModelAlias();
  const updateMutation = useUpdateModelAlias();
  const deleteMutation = useDeleteModelAlias();
  const reorderMutation = useReorderModelAliases();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAlias, setEditingAlias] = useState<ModelAliasRow | null>(null);
  const [aliasName, setAliasName] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ModelAliasRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { copy } = useClipboard();
  const scheduleCopyReset = useTrackedTimeout();

  const aliases = useMemo(() => aliasesQuery.data ?? [], [aliasesQuery.data]);

  const openCreate = () => {
    setEditingAlias(null);
    setAliasName("");
    setTargetModel("");
    setDialogOpen(true);
  };

  const openEdit = (a: ModelAliasRow) => {
    setEditingAlias(a);
    setAliasName(a.alias);
    setTargetModel(a.targetModel);
    setDialogOpen(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!aliasName.trim() || !targetModel.trim()) return;

    if (editingAlias) {
      // Both fields are editable now: the alias name rides along with the
      // target, and the backend cascades a rename through alias chains and
      // combo members that referenced the old name.
      updateMutation.mutate(
        {
          id: editingAlias.id,
          request: { alias: aliasName.trim(), targetModel: targetModel.trim() },
        },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingAlias(null);
            toast.success("Alias updated");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not save the alias.")),
        },
      );
    } else {
      createMutation.mutate(
        { alias: aliasName.trim(), targetModel: targetModel.trim() },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setAliasName("");
            setTargetModel("");
            toast.success("Alias created");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not create the alias.")),
        },
      );
    }
  };

  const handleCopy = (text: string, id: string) => {
    void copy(text).then((ok) => {
      if (!ok) {
        toast.error("Copy failed");
        return;
      }
      setCopiedKey(id);
      scheduleCopyReset(() => setCopiedKey(null), 1500);
    });
  };

  return (
    <Card>
      <CardHeader
        title="Model Aliases"
        subtitle="Map readable names to real models (e.g. claude-mythos-5 → claude-opus-5)"
        icon={<Route size={16} />}
        action={
          <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={openCreate}>
            New Alias
          </Button>
        }
      />
      <CardBody>
        {aliasesQuery.isPending ? (
          <LoadingState label="Loading aliases..." />
        ) : aliasesQuery.isError ? (
          <ErrorState message="Failed to load aliases" onRetry={() => aliasesQuery.refetch()} />
        ) : aliases.length === 0 ? (
          <EmptyState
            title="No aliases defined"
            message="Create an alias to route short or friendly names to real provider model IDs."
          />
        ) : (
          <SortableList
            items={aliases}
            label="Model aliases"
            gap="8px"
            disabled={reorderMutation.isPending}
            onReorder={(ids) =>
              reorderMutation.mutate(ids, {
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Could not save the new order.")),
              })
            }
            renderItem={(a) => (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  padding: "10px 14px",
                  borderRadius: "10px",
                  border: "1px solid var(--inner-border)",
                  background: "var(--surface-2)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                    minWidth: 0,
                  }}
                >
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "var(--accent)",
                      background: "var(--accent-soft)",
                      padding: "3px 8px",
                      borderRadius: "6px",
                    }}
                  >
                    {a.alias}
                  </code>
                  <ArrowRight size={13} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {a.targetModel}
                  </code>
                </div>

                <Inline gap="4px" style={{ flexShrink: 0 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Copy size={13} />}
                    onClick={() => handleCopy(a.alias, a.id)}
                    title={copiedKey === a.id ? "Copied!" : "Copy alias"}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Pencil size={13} />}
                    onClick={() => openEdit(a)}
                    title="Edit target model"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    onClick={() => setDeleteConfirm(a)}
                    title="Delete alias"
                    style={{ color: "var(--red)" }}
                  />
                </Inline>
              </div>
            )}
          />
        )}
      </CardBody>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingAlias ? "Edit Model Alias" : "New Model Alias"}
      >
        <form
          onSubmit={handleSave}
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <Input
            label="Alias name"
            id="alias-name-input"
            value={aliasName}
            onChange={(e) => setAliasName(e.target.value)}
            placeholder="e.g. fast, sonnet, smart"
            required
          />
          <Inline gap="8px" align="flex-end">
            <div style={{ flex: 1 }}>
              <Input
                label="Target model"
                id="target-model-input"
                value={targetModel}
                onChange={(e) => setTargetModel(e.target.value)}
                placeholder="e.g. codex/gpt-5.5, claude/claude-sonnet-5"
                required
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setPickerOpen(true)}
              icon={<Search size={13} />}
            >
              Browse
            </Button>
          </Inline>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={targetModel ? [targetModel] : []}
            onToggle={() => {}}
            onSelectOne={(v) => setTargetModel(v)}
            title="Select target model"
            multi={false}
          />
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" type="button" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={
                createMutation.isPending ||
                updateMutation.isPending ||
                !aliasName.trim() ||
                !targetModel.trim()
              }
            >
              {editingAlias ? "Save Changes" : "Create Alias"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Model Alias"
      >
        <Stack gap="12px">
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Are you sure you want to delete alias <strong>{deleteConfirm?.alias}</strong>? Clients
            requesting this name will need their full model path.
          </p>
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteConfirm) {
                  deleteMutation.mutate(deleteConfirm.id, {
                    onSuccess: () => setDeleteConfirm(null),
                  });
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Alias"}
            </Button>
          </div>
        </Stack>
      </Dialog>
    </Card>
  );
}

// ── Combos Section ───────────────────────────────────────────────────────────

/** Member chips shown per combo row before collapsing to a "+N more" note. */
const COMBO_MEMBER_CHIP_MAX = 4;

function CombosSection(): ReactNode {
  const combosQuery = useModelCombos();
  const createMutation = useCreateModelCombo();
  const cloneMutation = useCloneModelCombo();
  const updateMutation = useUpdateModelCombo();
  const deleteMutation = useDeleteModelCombo();
  const reorderMutation = useReorderModelCombos();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCombo, setEditingCombo] = useState<ModelComboRow | null>(null);
  const [comboName, setComboName] = useState("");
  /**
   * The combo's members in the order the operator arranges them. Each one keeps
   * a stable id so drag reordering stays cheap (a remount would lose the grip
   * the operator is holding). A `Member` value lives only in this state; the
   * server contract and the wire payload carry just the string, so we strip the
   * id when persisting.
   */
  const [members, setMembers] = useState<readonly { id: string; value: string }[]>([]);
  const [strategy, setStrategy] = useState<ComboStrategy>("fallback");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ModelComboRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { copy } = useClipboard();
  const scheduleCopyReset = useTrackedTimeout();

  const memberValues = useMemo(() => members.map((m) => m.value), [members]);

  /**
   * Toggle a member in/out of the combo. Picker rows are not aware of ordering,
   * so a newly-toggled value lands at the end of whatever order the operator
   * had built — that is the least surprising place when "add" means append and
   * "remove" means drop the chip that already exists.
   */
  const handlePickerToggle = (value: string) => {
    if (memberValues.includes(value))
      setMembers(members.filter((m) => m.value !== value));
    else setMembers([...members, { id: makeId(), value: value.trim() }]);
  };

  const combos = combosQuery.data ?? [];

  const openCreate = () => {
    setEditingCombo(null);
    setComboName("");
    setMembers([]);
    setStrategy("fallback");
    setDialogOpen(true);
  };

  const openEdit = (c: ModelComboRow) => {
    setEditingCombo(c);
    setComboName(c.name);
    // A fresh id per row keeps SortableList stable across dialog (re)opens —
    // reusing ids from a prior open would let React's reconciliation reorder
    // lookups hit a stale tree and lose the chip an operator is mid-drag.
    setMembers(c.members.map((value) => ({ id: makeId(), value })));
    setDialogOpen(true);
  };

  /**
   * Clones a combo server-side: same members and strategy, named `${name}-clone`
   * (suffixed when taken). The server resolves the name so concurrent clones
   * cannot collide, and drops members that no longer resolve to a model, alias,
   * or combo — the clone still lands, and the toast names what was left out.
   */
  const handleClone = (c: ModelComboRow) => {
    cloneMutation.mutate(c.id, {
      onSuccess: (result) => {
        const skipped = result.skippedMembers;
        if (skipped.length > 0)
          toast.success(
            "Combo cloned",
            `${result.combo.name} — skipped unresolvable member${skipped.length > 1 ? "s" : ""}: ${skipped.join(", ")}`,
          );
        else toast.success("Combo cloned", result.combo.name);
      },
      onError: (error) => toast.error(getErrorMessage(error, "Could not clone the combo.")),
    });
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!comboName.trim() || memberValues.length === 0) return;

    if (editingCombo) {
      // Rename rides along with the member/strategy edit; the backend cascades
      // the name change through aliases and nested combos.
      updateMutation.mutate(
        {
          id: editingCombo.id,
          request: {
            name: comboName.trim(),
            members: memberValues,
            strategy,
          },
        },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingCombo(null);
            toast.success("Combo saved");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not save the combo.")),
        },
      );
    } else {
      createMutation.mutate(
        { name: comboName.trim(), members: memberValues, strategy },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setComboName("");
            setMembers([]);
            toast.success("Combo created");
          },
          onError: (error) => toast.error(getErrorMessage(error, "Could not create the combo.")),
        },
      );
    }
  };

  const handleStrategyChange = (combo: ModelComboRow, nextStrategy: ComboStrategy) => {
    updateMutation.mutate(
      {
        id: combo.id,
        request: { strategy: nextStrategy },
      },
      {
        onSuccess: () => toast.success("Combo strategy updated"),
        onError: (error) => toast.error(getErrorMessage(error, "Could not update the combo strategy.")),
      },
    );
  };

  const handleCopy = (text: string, id: string) => {
    void copy(text).then((ok) => {
      if (!ok) {
        toast.error("Copy failed");
        return;
      }
      setCopiedKey(id);
      scheduleCopyReset(() => setCopiedKey(null), 1500);
    });
  };

  return (
    <Card>
      <CardHeader
        title="Combos"
        subtitle="Combine multiple models with fallback, round-robin rotation, or fusion"
        icon={<Layers size={16} />}
        action={
          <Button variant="primary" size="sm" icon={<Plus size={13} />} onClick={openCreate}>
            New Combo
          </Button>
        }
      />
      <CardBody>
        {combosQuery.isPending ? (
          <LoadingState label="Loading combos..." />
        ) : combosQuery.isError ? (
          <ErrorState message="Failed to load combos" onRetry={() => combosQuery.refetch()} />
        ) : combos.length === 0 ? (
          <EmptyState
            title="No combos defined"
            message="Create a model combo to distribute requests across multiple models."
          />
        ) : (
          <SortableList
            items={combos}
            label="Model combos"
            disabled={reorderMutation.isPending}
            onReorder={(ids) =>
              reorderMutation.mutate(ids, {
                onError: (error) =>
                  toast.error(getErrorMessage(error, "Could not save the new order.")),
              })
            }
            renderItem={(c) => (
              <div
                style={{
                  // Same padding/radius as an alias row, but the members stay on
                  // their own line below the header.
                  padding: "10px 14px",
                  borderRadius: "10px",
                  border: "1px solid var(--inner-border)",
                  background: "var(--surface-2)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    flexWrap: "wrap",
                  }}
                >
                  {/* The strategy is already shown by the Select beside it; a
                      badge repeating the same value was redundant. */}
                  <strong style={{ fontSize: "13px" }}>{c.name}</strong>

                  <Inline gap="8px">
                    <Select
                      value={c.strategy}
                      onValueChange={(v) => handleStrategyChange(c, v as ComboStrategy)}
                      options={COMBO_STRATEGY_OPTIONS}
                    />
                    <Inline gap="4px">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Copy size={13} />}
                        onClick={() => handleCopy(c.name, c.id)}
                        title={copiedKey === c.id ? "Copied!" : "Copy combo name"}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<CopyPlus size={13} />}
                        onClick={() => handleClone(c)}
                        disabled={cloneMutation.isPending}
                        title="Clone combo (same members and strategy)"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Pencil size={13} />}
                        onClick={() => openEdit(c)}
                        title="Edit combo"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 size={13} />}
                        onClick={() => setDeleteConfirm(c)}
                        title="Delete combo"
                        style={{ color: "var(--red)" }}
                      />
                    </Inline>
                  </Inline>
                </div>

                <Inline gap="6px" style={{ flexWrap: "wrap" }}>
                  {c.members.slice(0, COMBO_MEMBER_CHIP_MAX).map((m) => (
                    <code
                      key={m}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                        background: "var(--surface-3)",
                        border: "1px solid var(--inner-border)",
                        padding: "2px 8px",
                        borderRadius: "6px",
                      }}
                    >
                      {m}
                    </code>
                  ))}
                  {c.members.length > COMBO_MEMBER_CHIP_MAX ? (
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--text-tertiary)",
                        fontFamily: "var(--font-mono)",
                        alignSelf: "center",
                      }}
                      title={c.members.slice(COMBO_MEMBER_CHIP_MAX).join(", ")}
                    >
                      +{c.members.length - COMBO_MEMBER_CHIP_MAX} more models
                    </span>
                  ) : null}
                </Inline>
              </div>
            )}
          />
        )}
      </CardBody>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editingCombo ? "Edit Model Combo" : "New Model Combo"}
      >
        <form
          onSubmit={handleSave}
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <Input
            label="Combo name"
            id="combo-name-input"
            value={comboName}
            onChange={(e) => setComboName(e.target.value)}
            placeholder="e.g. smart-combo, fast-pool"
            required
          />
          <Select
            label="Strategy"
            id="combo-strategy-select"
            value={strategy}
            onValueChange={(v) => setStrategy(v as ComboStrategy)}
            options={COMBO_STRATEGY_OPTIONS}
          />
          {strategy === "fusion" ? (
            <p style={{ fontSize: "11px", color: "var(--text-tertiary)", margin: 0 }}>
              Fusion runs every member as a panel in parallel, then the first member (the judge)
              synthesizes one final answer from the panel responses. The judge keeps the client's
              stream and tools; panel models answer non-streaming with tools stripped.
            </p>
          ) : null}
          <Stack gap="6px">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
                Member models — drag to reorder
              </label>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                icon={<Search size={12} />}
                onClick={() => setPickerOpen(true)}
              >
                Browse models
              </Button>
            </div>
            <div
              role="list"
              aria-label="Combo members"
              data-testid="combo-members-list"
              style={{
                minHeight: "44px",
                border: "1px dashed var(--inner-border)",
                borderRadius: "10px",
                padding: members.length === 0 ? 0 : "6px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              {members.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  style={{
                    flex: "1 1 auto",
                    minHeight: "44px",
                    background: "transparent",
                    border: "none",
                    color: "var(--text-tertiary)",
                    fontSize: "12px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  Pick models to add
                </button>
              ) : (
                <SortableList
                  items={members}
                  label="Combo members"
                  gap="4px"
                  onReorder={(ids) => {
                    const byId = new Map(members.map((m) => [m.id, m]));
                    setMembers(ids.map((id) => byId.get(id)!).filter(Boolean));
                  }}
                  renderItem={(m) => (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "6px 10px",
                        borderRadius: "8px",
                        border: "1px solid var(--inner-border)",
                        background: "var(--surface-2)",
                        width: "100%",
                        boxSizing: "border-box",
                      }}
                    >
                      <GripVertical
                        size={12}
                        style={{ color: "var(--text-tertiary)", flexShrink: 0, cursor: "grab" }}
                      />
                      <code
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "12px",
                          color: "var(--accent)",
                          flex: "1 1 auto",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={m.value}
                      >
                        {m.value}
                      </code>
                      <button
                        type="button"
                        onClick={() => handlePickerToggle(m.value)}
                        aria-label={`Remove ${m.value}`}
                        style={{
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          color: "var(--text-tertiary)",
                          display: "flex",
                          flexShrink: 0,
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                />
              )}
            </div>
          </Stack>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={memberValues}
            onToggle={handlePickerToggle}
            title="Select combo members"
            multi
          />
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" type="button" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={
                createMutation.isPending ||
                updateMutation.isPending ||
                !comboName.trim() ||
                memberValues.length === 0
              }
            >
              {editingCombo ? "Save Changes" : "Create Combo"}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        title="Delete Model Combo"
      >
        <Stack gap="12px">
          <p style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            Are you sure you want to delete combo <strong>{deleteConfirm?.name}</strong>? Any
            aliases pointing to it will fail to resolve.
          </p>
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}
          >
            <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleteConfirm) {
                  deleteMutation.mutate(deleteConfirm.id, {
                    onSuccess: () => setDeleteConfirm(null),
                  });
                }
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Combo"}
            </Button>
          </div>
        </Stack>
      </Dialog>
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function Combos(): ReactNode {
  return (
    <Stack gap="16px">
      <CombosSection />
      <AliasesSection />
    </Stack>
  );
}
