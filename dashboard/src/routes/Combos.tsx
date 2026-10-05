import { ArrowRight, Copy, CopyPlus, Layers, Pencil, Plus, Route, Search, Trash2, X } from "lucide-react";
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
      updateMutation.mutate(
        { id: editingAlias.id, request: { targetModel: targetModel.trim() } },
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
            disabled={Boolean(editingAlias)}
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
              variant="primary"
              style={{ background: "var(--red)", borderColor: "var(--red)" }}
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
  const [membersText, setMembersText] = useState("");
  const [strategy, setStrategy] = useState<ComboStrategy>("fallback");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<ModelComboRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { copy } = useClipboard();
  const scheduleCopyReset = useTrackedTimeout();

  const selectedMembers = useMemo(
    () =>
      membersText
        .split("\n")
        .map((m) => m.trim())
        .filter((m) => m.length > 0),
    [membersText],
  );
  const handlePickerToggle = (q: string) => {
    if (selectedMembers.includes(q))
      setMembersText(selectedMembers.filter((m) => m !== q).join("\n"));
    else setMembersText([...selectedMembers, q].join("\n"));
  };

  const combos = combosQuery.data ?? [];

  const openCreate = () => {
    setEditingCombo(null);
    setComboName("");
    setMembersText("");
    setStrategy("fallback");
    setDialogOpen(true);
  };

  const openEdit = (c: ModelComboRow) => {
    setEditingCombo(c);
    setComboName(c.name);
    setMembersText(c.members.join("\n"));
    setStrategy(c.strategy);
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
    const members = membersText
      .split("\n")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    if (!comboName.trim() || members.length === 0) return;

    if (editingCombo) {
      // Rename rides along with the member/strategy edit; the backend cascades
      // the name change through aliases and nested combos.
      updateMutation.mutate(
        {
          id: editingCombo.id,
          request: {
            name: comboName.trim(),
            members,
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
        { name: comboName.trim(), members, strategy },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setComboName("");
            setMembersText("");
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
          <Stack gap="4px">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
                Member models (one per line, e.g. codex/gpt-5.5)
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
            <textarea
              value={membersText}
              onChange={(e) => setMembersText(e.target.value)}
              placeholder="codex/gpt-5.5&#10;openai/gpt-4o&#10;cerebras/llama3.3-70b"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid var(--inner-border)",
                background: "var(--input-bg)",
                color: "var(--text-primary)",
                resize: "vertical",
              }}
              required
            />
            {selectedMembers.length > 0 && (
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
                {selectedMembers.map((m) => (
                  <span
                    key={m}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "11px",
                      background: "var(--accent-soft)",
                      color: "var(--accent)",
                      padding: "2px 8px",
                      borderRadius: "6px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    {m}
                    <button
                      type="button"
                      onClick={() => handlePickerToggle(m)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                        display: "flex",
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Stack>
          <ModelPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            selected={selectedMembers}
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
                !membersText.trim()
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
              variant="primary"
              style={{ background: "var(--red)", borderColor: "var(--red)" }}
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
