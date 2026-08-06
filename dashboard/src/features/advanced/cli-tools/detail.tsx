/** CLI Tool detail page — dedicated config page for a single tool. */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Download, RotateCcw, Settings2, CheckCircle2, XCircle, Copy, ExternalLink } from "lucide-react";
import { cn } from "../../../lib/cn";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { Label } from "../../../components/ui/input";
import { ModelPickerField, ModelTargetPicker } from "../../../components/model-picker";
import { toast } from "../../../lib/toast";
import { useToolRegistry, useToolStatuses, useApplyTool, useResetTool, useDownloadTool, useApiKeys, fetchApiKeyCredential } from "./api";
import { ToolIcon } from "./tool-icon";
import type { ApplyInput, ToolRegistryEntry, ToolStatus } from "./types";

export function CliToolDetailPage() {
  const { toolId } = useParams<{ toolId: string }>();
  const navigate = useNavigate();
  const registryQuery = useToolRegistry();
  const statusesQuery = useToolStatuses();

  const def = useMemo(
    () => registryQuery.data?.find((t) => t.id === toolId) ?? null,
    [registryQuery.data, toolId],
  );

  const status = toolId ? statusesQuery.data?.[toolId] : undefined;

  if (registryQuery.isLoading) {
    return <div className="dashboard-page p-4 text-sm text-[var(--text-3)]">Loading...</div>;
  }

  if (!def) {
    return (
      <div className="dashboard-page space-y-4">
        <p className="text-sm text-[var(--text-3)]">Tool not found.</p>
        <Link to="/advanced/cli-tools" className="text-xs text-[var(--accent)]">← Back to CLI Tools</Link>
      </div>
    );
  }

  return <ToolDetailContent def={def} status={status} onBack={() => navigate("/advanced/cli-tools")} />;
}

function ToolDetailContent({
  def,
  status,
  onBack,
}: {
  def: ToolRegistryEntry;
  status: ToolStatus | undefined;
  onBack: () => void;
}) {
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>(() => def.defaultModels.map((m) => m.id));
  const [activeModel, setActiveModel] = useState("");

  const apiKeysQuery = useApiKeys();
  const applyMutation = useApplyTool();
  const resetMutation = useResetTool();
  const downloadMutation = useDownloadTool();

  const isGuide = def.configType === "guide";
  const installed = status?.installed ?? false;
  const configured = status?.configured ?? false;

  const activeKeys = useMemo(
    () => apiKeysQuery.data?.items.filter((k) => k.active) ?? [],
    [apiKeysQuery.data],
  );

  // Auto-select first key on mount.
  useEffect(() => {
    if (!selectedKeyId && activeKeys.length > 0) {
      setSelectedKeyId(activeKeys[0]!.id);
    }
  }, [activeKeys, selectedKeyId]);

  const endpoint = useMemo(() => {
    if (typeof window === "undefined") return "http://localhost:12800";
    const { protocol, hostname, port } = window.location;
    return `${protocol}//${hostname}:${port || "12800"}`;
  }, []);

  const buildInput = useCallback(async (): Promise<ApplyInput | null> => {
    if (activeKeys.length === 0) {
      toast.error("No active API keys. Create one in API Keys first.");
      return null;
    }
    const keyId = selectedKeyId || activeKeys[0]!.id;
    const apiKey = await fetchApiKeyCredential(keyId);
    if (!apiKey) {
      toast.error("Failed to fetch API key credential.");
      return null;
    }
    return {
      endpoint,
      apiKey,
      models: selectedModels,
      activeModel: activeModel || selectedModels[0] || undefined,
    };
  }, [activeKeys, selectedKeyId, selectedModels, activeModel, endpoint]);

  const handleApply = useCallback(async () => {
    const input = await buildInput();
    if (input) applyMutation.mutate({ toolId: def.id, input });
  }, [buildInput, applyMutation, def.id]);

  const handleReset = useCallback(() => {
    if (!confirm(`Reset ${def.name} config? This removes only Cartethyia-injected fields.`)) return;
    resetMutation.mutate(def.id);
  }, [def.id, def.name, resetMutation]);

  const handleDownload = useCallback(async () => {
    const input = await buildInput();
    if (input) downloadMutation.mutate({ toolId: def.id, input });
  }, [buildInput, downloadMutation, def.id]);

  const handleCopy = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  }, []);

  return (
    <div className="dashboard-page space-y-4">
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
      >
        <ArrowLeft size={14} />
        Back to CLI Tools
      </button>

      {/* Tool header */}
      <Card className={cn(configured && "border-[var(--accent)]/40")}>
        <div className="flex items-start gap-3">
          <ToolIcon toolId={def.id} name={def.name} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-[var(--text-1)]">{def.name}</h2>
              {installed ? (
                <span className="flex items-center gap-1 text-[10.5px] text-[var(--accent)]">
                  <CheckCircle2 size={12} /> Installed
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10.5px] text-[var(--text-3)]">
                  <XCircle size={12} /> Not installed
                </span>
              )}
              {configured && (
                <Badge tone="accent">CONFIGURED</Badge>
              )}
            </div>
            <p className="mt-0.5 text-xs text-[var(--text-2)]">{def.description}</p>
            {def.settingsFile && (
              <p className="mt-1 text-[10.5px] font-mono text-[var(--text-3)]">{def.settingsFile}</p>
            )}
            {status?.currentEndpoint && (
              <p className="mt-0.5 text-[10.5px] text-[var(--text-2)]">
                Endpoint: <span className="font-mono">{status.currentEndpoint}</span>
              </p>
            )}
            {def.docsUrl && (
              <a
                href={def.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-[var(--accent)] hover:underline"
              >
                <ExternalLink size={11} /> Documentation
              </a>
            )}
          </div>
        </div>
      </Card>

      {/* Notes */}
      {def.notes && def.notes.length > 0 && (
        <div className="space-y-1.5">
          {def.notes.map((note, i) => (
            <div
              key={i}
              className={cn(
                "rounded-[var(--radius-control)] border px-3 py-2 text-[11px]",
                note.type === "warning" && "border-[var(--orange-soft)] bg-[var(--orange-soft)] text-[var(--orange)]",
                note.type === "error" && "border-[var(--red-soft)] bg-[var(--red-soft)] text-[var(--red)]",
                note.type === "info" && "border-[var(--teal-soft)] bg-[var(--teal-soft)] text-[var(--teal)]",
              )}
            >
              {note.text}
            </div>
          ))}
        </div>
      )}

      {/* Guide-only: show steps + code block */}
      {isGuide ? (
        <GuideContent def={def} endpoint={endpoint} onCopy={handleCopy} />
      ) : (
        <Card>
          <div className="space-y-4">
            {/* API key selector */}
            <div>
              <Label htmlFor="api-key-select">API Key</Label>
              <select
                id="api-key-select"
                value={selectedKeyId}
                onChange={(e) => setSelectedKeyId(e.target.value)}
                className="w-full rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-sm text-[var(--text-1)] outline-none transition-colors duration-150 focus:border-[var(--accent)]"
              >
              {activeKeys.length === 0 && <option value="">No active keys — create one first</option>}
              {activeKeys.map((k) => (
                <option key={k.id} value={k.id}>{k.name} ({k.keyPrefix}...)</option>
              ))}
            </select>
          </div>

          {/* Model picker — uses the existing ModelPickerField with inline catalog browser */}
          <ModelPickerField
            label="Models"
            hint="Pick from the catalog or type a custom model ID"
            values={selectedModels}
            onChange={setSelectedModels}
            mode="models"
          />

          {/* Active model — single value picker */}
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold text-[var(--text-2)]">Active Model</label>
            <ModelTargetPicker
              value={activeModel}
              onChange={setActiveModel}
              placeholder={selectedModels[0] ?? "auto"}
            />
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={handleApply} disabled={applyMutation.isPending || activeKeys.length === 0}>
              <Settings2 size={14} className="mr-1.5" />
              {applyMutation.isPending ? "Applying..." : "Quick Setup"}
            </Button>
            <Button variant="outline" onClick={handleDownload} disabled={downloadMutation.isPending}>
              <Download size={14} className="mr-1.5" />
              {downloadMutation.isPending ? "Downloading..." : "Download Config"}
            </Button>
            {configured && (
              <Button variant="ghost" onClick={handleReset} disabled={resetMutation.isPending}>
                <RotateCcw size={14} className="mr-1.5" />
                {resetMutation.isPending ? "Resetting..." : "Reset"}
              </Button>
            )}
          </div>
          </div>
        </Card>
      )}

      {/* Guide tools also get download */}
      {isGuide && (
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleDownload} disabled={downloadMutation.isPending}>
            <Download size={14} className="mr-1.5" />
            {downloadMutation.isPending ? "Downloading..." : "Download Config"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Guide steps + code block with copy buttons. */
function GuideContent({
  def,
  endpoint,
  onCopy,
}: {
  def: ToolRegistryEntry;
  endpoint: string;
  onCopy: (text: string, label: string) => void;
}) {
  const codeBlock = def.codeBlock;
  const processedCode = useMemo(() => {
    if (!codeBlock) return null;
    return codeBlock.code
      .replace(/\{\{baseUrl\}\}/g, endpoint)
      .replace(/\{\{apiKey\}\}/g, "YOUR_API_KEY")
      .replace(/\{\{model\}\}/g, def.defaultModels[0]?.id ?? "model");
  }, [codeBlock, endpoint, def.defaultModels]);

  return (
    <Card>
      <div className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-3)]">Setup Guide</h3>

        {def.guideSteps?.map((step) => (
          <div key={step.step} className="flex gap-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[11px] font-bold text-[var(--text-2)]">
              {step.step}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-[var(--text-1)]">{step.title}</p>
              {step.desc && <p className="mt-0.5 text-[11px] text-[var(--text-3)]">{step.desc}</p>}
              {step.value && (
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface-muted)] px-2 py-1 text-[10.5px] font-mono text-[var(--text-2)]">
                    {step.value.replace(/\{\{baseUrl\}\}/g, endpoint)}
                  </code>
                  {step.copyable && (
                    <button type="button" onClick={() => onCopy(step.value!.replace(/\{\{baseUrl\}\}/g, endpoint), "Value")} className="shrink-0 text-[var(--text-3)] hover:text-[var(--text-1)]">
                      <Copy size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {processedCode && (
          <div className="relative mt-2">
            <pre className="overflow-x-auto rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-muted)] p-3 text-[10.5px] font-mono leading-relaxed text-[var(--text-2)]">
              {processedCode}
            </pre>
            <button
              type="button"
              onClick={() => onCopy(processedCode, "Config")}
              className="absolute right-2 top-2 rounded p-1.5 text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
            >
              <Copy size={14} />
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
