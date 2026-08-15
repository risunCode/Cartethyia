/* @jsxImportSource solid-js */

import { Bot, Copy, Download, FileUp, FlaskConical, Plus, PowerOff, Trash2 } from "lucide-solid";
import { For, Show, type JSX } from "solid-js";
import { formatTokens } from "../../../lib/format";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { formatModelPricing } from "../formatters";
import type { ModelEntry, ProviderCapability } from "./types";
import { PROVIDER_CAPABILITY_LABELS } from "./types";
import { cn } from "../../../lib/cn";

export interface ModelListProps {
  prefix: string;
  capability: ProviderCapability | null;
  models: ModelEntry[];
  fetchedModels: ModelEntry[];
  canAddModels: boolean;
  canFetchModels: boolean;
  onAddModel: () => void;
  onFetchModels: () => void;
  onDeleteFetched: () => void;
  onDisableAll: () => void;
  onTestModel: (model: ModelEntry) => void;
  onToggleModel: (model: ModelEntry) => void;
  onRemoveModel: (model: ModelEntry) => void;
}

export function ModelList(props: ModelListProps): JSX.Element {
  return (
    <Card>
      <div class="mb-4 flex items-start justify-between gap-3">
        <div>
          <div class="text-sm font-bold">{props.capability ? `${PROVIDER_CAPABILITY_LABELS[props.capability]} Models` : "Available Models"}</div>
          <div class="mt-0.5 text-[11.5px] text-[var(--text-2)]">{props.models.filter((model) => model.enabled).length} active · {props.models.filter((model) => !model.enabled).length} disabled</div>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <Show when={props.canAddModels}>
            <Button size="sm" variant="secondary" onClick={props.onAddModel}><Plus size={13} /> Add Model</Button>
          </Show>
          <Show when={props.canFetchModels}>
            <Button size="sm" variant="secondary" onClick={props.onFetchModels}><Download size={13} /> Fetch models</Button>
          </Show>
          <Show when={props.fetchedModels.length > 0}>
            <Button size="sm" variant="ghost" onClick={props.onDeleteFetched}><Trash2 size={13} /> Delete fetched</Button>
          </Show>
          <Button size="sm" variant="secondary" onClick={props.onDisableAll}><PowerOff size={13} /> Disable all</Button>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <For each={props.models}>
          {(model) => (
            <Card className={cn("flex min-h-[168px] flex-col gap-1.5 rounded-xl p-2.5", !model.enabled && "opacity-65")}>
              <div class="flex min-h-[34px] items-start gap-1.5">
                <Bot size={14} class="mt-0.5 shrink-0 text-[var(--text-3)]" />
                <div class="min-w-0 flex-1">
                  <div class="break-all font-mono text-[10px] font-semibold">{props.prefix}/{model.id}</div>
                  <div class="break-all text-[9px] text-[var(--text-3)]">{model.id}</div>
                </div>
                <Button variant="ghost" size="icon" aria-label={`Copy ${props.prefix}/${model.id}`} onClick={() => navigator.clipboard?.writeText(`${props.prefix}/${model.id}`)}><Copy size={12} /></Button>
              </div>
              <div class="flex min-h-[18px] flex-wrap gap-1">
                {model.source !== "built-in" && <FileUp size={11} />}
                {model.reasoning && <span class="rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px]">Reasoning</span>}
                {model.vision && <span class="rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px]">Vision</span>}
                {model.websearch && <span class="rounded-md bg-[var(--hover)] px-1.5 py-0.5 text-[9px]">Web</span>}
              </div>
              <div class="flex-1 text-[9px] text-[var(--text-2)]">{model.contextWindow ? `${formatTokens(model.contextWindow)} context` : "Context unknown"} · {model.maxOutputTokens ? `${formatTokens(model.maxOutputTokens)} max out` : "max out unknown"}<div>{formatModelPricing(model.pricing) ?? "Pricing unknown"}</div></div>
              <div class="flex gap-1.5">
                <Show when={model.enabled}>
                  <Button variant="secondary" size="sm" onClick={() => props.onTestModel(model)}><FlaskConical size={10} /> Test</Button>
                </Show>
                <Button variant="secondary" size="sm" onClick={() => props.onToggleModel(model)}>{model.enabled ? "Disable" : "Enable"}</Button>
                <Button variant="ghost" size="sm" onClick={() => props.onRemoveModel(model)}><Trash2 size={10} /> Delete</Button>
              </div>
            </Card>
          )}
        </For>
      </div>
    </Card>
  );
}
