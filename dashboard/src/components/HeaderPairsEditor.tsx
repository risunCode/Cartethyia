/** Reusable key/value editor for a custom provider's extra outbound HTTP headers
 * (`compatibilityProfile.extra_headers`, validated end-to-end by the provider
 * catalog service). */
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type HeaderPair = readonly [key: string, value: string];

export function pairsToHeaders(pairs: readonly HeaderPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (key.trim()) out[key.trim()] = value;
  }
  return out;
}

export function HeaderPairsEditor({
  pairs,
  onChange,
}: {
  pairs: readonly HeaderPair[];
  onChange: (pairs: readonly HeaderPair[]) => void;
}): ReactNode {
  const setPair = (index: number, next: HeaderPair) =>
    onChange(pairs.map((pair, i) => (i === index ? next : pair)));
  const removePair = (index: number) => onChange(pairs.filter((_, i) => i !== index));

  return (
    <div className="form-group">
      <label className="form-label" style={{ display: "block" }}>
        <span style={{ display: "block" }}>Custom Headers</span>
        <span className="form-hint" style={{ display: "block", marginTop: "2px" }}>
          Optional — sent with every request, override built-in headers on a name collision
        </span>
      </label>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {pairs.map(([key, value], index) => (
          <div key={index} style={{ display: "flex", minWidth: 0, gap: "6px" }}>
            <Input
              placeholder="Header-Name"
              value={key}
              onChange={(e) => setPair(index, [e.target.value, value])}
              style={{ minWidth: 0, flex: 1, fontFamily: "var(--font-mono)", fontSize: "12px" }}
            />
            <Input
              placeholder="value"
              value={value}
              onChange={(e) => setPair(index, [key, e.target.value])}
              style={{ minWidth: 0, flex: 1, fontFamily: "var(--font-mono)", fontSize: "12px" }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${key || "header"}`}
              onClick={() => removePair(index)}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onChange([...pairs, ["", ""]])}
        >
          <Plus size={13} /> Add header
        </Button>
      </div>
    </div>
  );
}
