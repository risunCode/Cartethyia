import type { ComponentType } from "react";
import { Construction } from "lucide-react";
import { Card } from "../../components/ui/card";

interface PlaceholderProps {
  title: string;
  description: string;
  icon?: ComponentType<{ size?: number; className?: string }>;
}

/**
 * Placeholder for advanced sidebar pages — mirrors the Console layout:
 * full-height, flex column, with a centered "Content will be here" blur.
 */
export function AdvancedPlaceholder({ title, description, icon: Icon }: PlaceholderProps) {
  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {Icon && <Icon size={16} className="text-[var(--text-3)]" />}
          <div className="min-w-0">
            <h2 className="text-sm font-bold tracking-tight">{title}</h2>
            <p className="truncate text-[11.5px] text-[var(--text-2)]">{description}</p>
          </div>
        </div>
      </Card>
      <Card className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <Construction size={40} className="text-[var(--text-3)]/40" aria-hidden={true} />
        <p className="text-sm font-semibold text-[var(--text-3)]">Content will be here.</p>
        <p className="text-[10.5px] text-[var(--text-3)]/60">{title} — coming soon</p>
      </Card>
    </div>
  );
}
