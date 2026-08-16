/** Reusable key/value editor for a custom provider's extra outbound HTTP headers. */


import { For } from "solid-js";
import { Plus, Trash2 } from "lucide-solid";
import { Button } from "./ui/button";
import { Input, Label } from "./ui/input";

export type HeaderPair = [key: string, value: string];

export function headersToPairs(headers: Record<string, string> | undefined): HeaderPair[] {
  return headers ? Object.entries(headers) : [];
}

/** Drops blank-key rows — those exist only mid-edit and were never meant to be sent. */
export function pairsToHeaders(pairs: HeaderPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (key.trim()) out[key.trim()] = value;
  }
  return out;
}

export function HeaderPairsEditor(props: { pairs: HeaderPair[]; onChange: (pairs: HeaderPair[]) => void }) {
  const setPair = (index: number, next: HeaderPair) => props.onChange(props.pairs.map((pair, i) => (i === index ? next : pair)));
  const removePair = (index: number) => props.onChange(props.pairs.filter((_, i) => i !== index));

  return (
    <div>
      <Label>Custom headers (optional) — sent with every request, override built-in auth/content-type on a name collision</Label>
      <div class="space-y-1.5">
        <For each={props.pairs}>{(pair, index) => (
          <div class="flex min-w-0 gap-1.5">
            <Input placeholder="Header-Name" value={pair[0]} onInput={(event) => setPair(index(), [event.currentTarget.value, pair[1]])} class="min-w-0 flex-1 font-mono text-xs" />
            <Input placeholder="value" value={pair[1]} onInput={(event) => setPair(index(), [pair[0], event.currentTarget.value])} class="min-w-0 flex-1 font-mono text-xs" />
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${pair[0] || "header"}`} onClick={() => removePair(index())}>
              <Trash2 size={13} />
            </Button>
          </div>
        )}</For>
        <Button type="button" variant="secondary" size="sm" onClick={() => props.onChange([...props.pairs, ["", ""]])}>
          <Plus size={13} /> Add header
        </Button>
      </div>
    </div>
  );
}

