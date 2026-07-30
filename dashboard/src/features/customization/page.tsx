/**
 * Customization — cosmetic settings (theme, custom theme editor). Preview
 * placeholder; the actual theme editor lands in a follow-up.
 */

import { Palette } from "lucide-react";
import { Card, CardHeader } from "../../components/ui/card";

export function CustomizationPage() {
  return (
    <Card>
      <CardHeader title="Customization" icon={Palette} sub="Theme and cosmetic preferences." />
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--inner-border)] py-16 text-center">
        <Palette size={28} className="text-[var(--text-3)]" />
        <p className="text-sm font-semibold text-[var(--text-1)]">Coming soon</p>
        <p className="max-w-sm text-xs text-[var(--text-2)]">Custom themes and cosmetic controls will live here.</p>
      </div>
    </Card>
  );
}
