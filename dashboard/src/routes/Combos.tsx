import { ArrowRight, Copy, Layers, Pencil, Plus, Route, Search, Trash2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { ModelPickerModal } from "../components/ModelPicker";
import { useTrackedTimeout } from "../lib/use-timeout";
import { useClipboard } from "../lib/use-clipboard";
import { toast } from "../lib/toast";
import type { ComboStrategy, ModelAliasRow, ModelComboRow } from "../lib/contracts";
import { COMBO_STRATEGY_OPTIONS } from "../lib/combo-strategy";
import {
  useCreateModelAlias,
  useCreateModelCombo,
  useDeleteModelAlias,
  useDeleteModelCombo,
  useModelAliases,
  useModelCombos,
  useUpdateModelAlias,
  useUpdateModelCombo,
} from "../lib/hooks/routing";

// ── Aliases Section ──────────────────────────────────────────────────────────

function AliasesSection(): ReactNode {
  const aliasesQuery = useModelAliases();
  const createMutation = useCreateModelAlias();
  const updateMutation = useUpdateModelAlias();
  const deleteMutation = useDeleteModelAlias();
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
          },
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
          },
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
          <Stack gap="8px">
            {aliases.map((a) => (
              <div
                key={a.id}
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
            ))}
          </Stack>
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

function CombosSection(): ReactNode {
  const combosQuery = useModelCombos();
  const createMutation = useCreateModelCombo();
  const updateMutation = useUpdateModelCombo();
  const deleteMutation = useDeleteModelCombo();

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

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const members = membersText
      .split("\n")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    if (!comboName.trim() || members.length === 0) return;

    if (editingCombo) {
      updateMutation.mutate(
        { id: editingCombo.id, request: { members, strategy } },
        {
          onSuccess: () => {
            setDialogOpen(false);
            setEditingCombo(null);
          },
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
          },
        },
      );
    }
  };

  const handleStrategyChange = (combo: ModelComboRow, nextStrategy: ComboStrategy) => {
    updateMutation.mutate({
      id: combo.id,
      request: { strategy: nextStrategy },
    });
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
        subtitle="Combine multiple models with fallback or round-robin rotation"
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
          <Stack gap="10px">
            {combos.map((c) => (
              <div
                key={c.id}
                style={{
                  padding: "14px 16px",
                  borderRadius: "12px",
                  border: "1px solid var(--inner-border)",
                  background: "var(--surface-2)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
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
                  <Inline gap="8px">
                    <strong style={{ fontSize: "14px" }}>{c.name}</strong>
                    <Badge tone="accent">
                      {c.strategy === "round_robin" ? "round-robin" : "fallback"}
                    </Badge>
                  </Inline>

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
                  {c.members.map((m) => (
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
                </Inline>
              </div>
            ))}
          </Stack>
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
            disabled={Boolean(editingCombo)}
            required
          />
          <Select
            label="Strategy"
            id="combo-strategy-select"
            value={strategy}
            onValueChange={(v) => setStrategy(v as ComboStrategy)}
            options={COMBO_STRATEGY_OPTIONS}
          />
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
