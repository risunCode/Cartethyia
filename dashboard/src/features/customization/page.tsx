/**
 * Customization — cosmetic settings (theme, custom theme editor). Preview
 * placeholder; the actual theme editor lands in a follow-up.
 */

import { Image, LockKeyhole, Sparkles, WandSparkles } from "lucide-react";
import { useState } from "react";
import { Card, CardHeader } from "../../components/ui/card";
import { BackgroundUpload, SeasonalItemUpload, useCustomizationSettings } from "./background";
import { toast } from "sonner";

export function CustomizationPage() {
  const [settings, setSettings] = useCustomizationSettings();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader title="Appearance" icon={WandSparkles} sub="Tune the visual layer once; it follows you across the console." />
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-4">
            <div className="mb-3 flex items-center gap-2"><Image size={16} className="text-[var(--accent)]" /><div><h2 className="text-sm font-semibold">Custom background</h2><p className="text-xs text-[var(--text-2)]">The image stays behind the frosted glass surfaces.</p></div></div>
            <div className="mb-3 overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg)]">
              {settings.backgroundDataUrl ? <div className="aspect-[16/5] min-h-24 bg-cover bg-center" style={{ backgroundImage: `url(${settings.backgroundDataUrl})` }} aria-label="Custom background preview" /> : <div className="flex aspect-[16/5] min-h-24 items-center justify-center bg-[radial-gradient(circle_at_25%_20%,rgba(251,146,60,.22),transparent_45%),radial-gradient(circle_at_80%_80%,rgba(99,102,241,.2),transparent_45%)] text-xs text-[var(--text-3)]">No custom image selected</div>}
            </div>
            <BackgroundUpload onError={(message) => { setError(message); toast.error(message); }} />
            {error && <p className="mt-2 text-xs text-[var(--red)]">{error}</p>}
          </section>
          <section className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-4">
            <div className="mb-3 flex items-center gap-2"><LockKeyhole size={16} className="text-[var(--accent)]" /><div><h2 className="text-sm font-semibold">Seasonal atmosphere</h2><p className="text-xs text-[var(--text-2)]">Locks effect only, copied from DownAria.</p></div></div>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--inner-border)] bg-[var(--glass-bg)] px-3 py-2.5 text-xs text-[var(--text-2)]">
              <span className="flex items-center gap-2"><Sparkles size={14} /> Floating locks</span>
              <input type="checkbox" checked={settings.locksEnabled} onChange={(event) => setSettings({ locksEnabled: event.target.checked })} className="size-4 accent-[var(--accent)]" />
            </label>
            <label className="mt-3 block text-xs text-[var(--text-2)]">Frequency <span className="float-right font-mono text-[var(--text-3)]">{settings.locksFrequency.toFixed(1)}×</span><input type="range" min="0.5" max="2.5" step="0.1" value={settings.locksFrequency} onChange={(event) => setSettings({ locksFrequency: Number(event.target.value) })} className="mt-1 w-full accent-[var(--accent)]" /><span className="mt-1 flex justify-between text-[10px] text-[var(--text-3)]"><span>Calm</span><span>Active</span></span></label>
            <div className="mb-3 flex items-center gap-3 rounded-xl border border-[var(--inner-border)] bg-[var(--glass-bg)] px-3 py-2.5">
              <div className="flex size-10 items-center justify-center rounded-lg bg-[var(--hover)]"><img src={settings.seasonalItemDataUrl ?? `${import.meta.env.BASE_URL}custom_seasonal/diamondlock_kindpng_4497640.png`} alt="" className="size-7 object-contain" /></div>
              <div className="min-w-0"><div className="text-xs font-medium">{settings.seasonalItemDataUrl ? "Custom item active" : "Default lock set"}</div><div className="text-[10px] text-[var(--text-3)]">{settings.locksEnabled ? "Floating across the console" : "Effect currently disabled"}</div></div>
              <Sparkles size={15} className="ml-auto shrink-0 text-[var(--accent)]" aria-hidden="true" />
            </div>
            <SeasonalItemUpload onError={(message) => { setError(message); toast.error(message); }} />
          </section>
        </div>
      </Card>
    </div>
  );
}
