/** Reusable key/value editor for a custom provider's extra outbound HTTP headers. */

import { Plus, Trash2 } from "lucide-react";
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

export function HeaderPairsEditor({ pairs, onChange }: { pairs: HeaderPair[]; onChange: (pairs: HeaderPair[]) => void }) {
  const setPair = (index: number, next: HeaderPair) => onChange(pairs.map((pair, i) => (i === index ? next : pair)));
  const removePair = (index: number) => onChange(pairs.filter((_, i) => i !== index));

  return (
    <div>
      <Label>Custom headers (optional) — sent with every request, override built-in auth/content-type on a name collision</Label>
      <div className="space-y-1.5">
        {pairs.map(([key, value], index) => (
          <div key={index} className="flex gap-1.5">
            <Input placeholder="Header-Name" value={key} onChange={(e) => setPair(index, [e.target.value, value])} className="flex-1 font-mono text-xs" />
            <Input placeholder="value" value={value} onChange={(e) => setPair(index, [key, e.target.value])} className="flex-1 font-mono text-xs" />
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${key || "header"}`} onClick={() => removePair(index)}>
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...pairs, ["", ""]])}>
          <Plus size={13} /> Add header
        </Button>
      </div>
    </div>
  );
}
