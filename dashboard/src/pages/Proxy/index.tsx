import { ArrowDownToLine, Link2, ShieldCheck } from "lucide-solid";
import type { JSX } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { Button } from "@components/ui/button";
import { Badge } from "@components/ui/badge";
import { Input, Label, Textarea } from "@components/ui/input";
import { StatePanel } from "@components/ui/state";

/** Proxy extraction workspace skeleton. Wiring is intentionally deferred. */
export default function Proxy(): JSX.Element {
  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Proxy</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">Extract media from a supported URL through the gateway.</p>
        </div>
        <Badge tone="neutral">Skeleton workspace</Badge>
      </header>

      <section class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,.8fr)]">
        <Card density="comfortable">
          <CardHeader title="New extraction" icon={Link2} iconColor="var(--accent)" sub="The URL is the only required input." />
          <form class="space-y-4" onSubmit={(event) => event.preventDefault()}>
            <div>
              <Label htmlFor="proxy-url">Source URL</Label>
              <Input id="proxy-url" type="url" placeholder="https://example.com/video…" autocomplete="url" />
              <p class="mt-1 text-[10px] text-[var(--text-3)]">Supports video, audio, and image extraction profiles.</p>
            </div>
            <div>
              <Label htmlFor="proxy-cookie">Session cookie <span class="font-normal text-[var(--text-3)]">(optional)</span></Label>
              <Textarea id="proxy-cookie" placeholder="Optional platform cookie for authenticated content…" rows={3} />
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--inner-border)] pt-3">
              <span class="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-3)]">
                <ShieldCheck size={13} class="text-[var(--status-success)]" aria-hidden="true" />
                Credentials stay scoped to this request
              </span>
              <Button type="button" disabled>
                <ArrowDownToLine size={14} aria-hidden="true" />
                Extract media
              </Button>
            </div>
          </form>
        </Card>

        <Card density="comfortable">
          <CardHeader title="Resolved media" icon={ArrowDownToLine} iconColor="var(--status-success)" sub="Extraction results will appear here." />
          <StatePanel
            kind="empty"
            title="No extraction yet"
            description="Submit a source URL to see platform, profile, metadata, and downloadable media variants."
            icon={Link2}
            density="compact"
          />
        </Card>
      </section>

      <Card density="compact">
        <CardHeader title="Supported result shape" sub="Prepared for the downloader extractor contract" />
        <div class="grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
          <ResultHint label="Platform" value="facebook · instagram · tiktok" />
          <ResultHint label="Profile" value="native / external fallback" />
          <ResultHint label="Media" value="video · audio · image" />
          <ResultHint label="Variants" value="quality · size · format" />
        </div>
      </Card>
    </div>
  );
}

function ResultHint(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5">
      <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{props.label}</div>
      <div class="mt-1 truncate text-[var(--text-2)]" title={props.value}>{props.value}</div>
    </div>
  );
}
