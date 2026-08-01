import { Clock3, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Card } from "../../components/ui/card";

const FUTURE_AREAS = [
  { icon: SlidersHorizontal, title: "Routing strategy", description: "Account strategy, sticky client allocation, failover and retry policies." },
  { icon: ShieldCheck, title: "Proxy policy", description: "Proxy selection, exclusion rules and request-level controls." },
];

export function ProxyRequestsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-lg font-bold tracking-tight">Proxy & Requests</h1>
        <p className="text-xs text-[var(--text-2)]">Central controls for proxy behavior and request routing.</p>
      </div>
      <Card className="overflow-hidden p-0">
        <div className="border-b border-[var(--inner-border)] bg-[var(--hover)] px-4 py-5 sm:px-6 sm:py-7">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]"><Clock3 size={19} /></span>
          <h2 className="mt-3 text-base font-bold">Coming soon</h2>
          <p className="mt-1 max-w-xl text-sm text-[var(--text-2)]">This control surface will consolidate request policies without duplicating provider-level settings.</p>
        </div>
        <div className="grid gap-px bg-[var(--inner-border)] sm:grid-cols-2">
          {FUTURE_AREAS.map(({ icon: Icon, title, description }) => (
            <div key={title} className="bg-[var(--surface)] p-4 sm:p-5">
              <Icon size={16} className="text-[var(--accent)]" />
              <h3 className="mt-2 text-sm font-semibold">{title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-3)]">{description}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
