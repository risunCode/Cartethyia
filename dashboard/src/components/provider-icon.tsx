
import { createSignal } from "solid-js";
import { cn } from "../lib/cn";

const failedIcons = new Set<string>();
const iconAssets: Record<string, { file: string; ext: "svg" | "webp" }> = {
  claude: { file: "claude-code", ext: "svg" }, opencodeft: { file: "opencode", ext: "webp" }, opencodezen: { file: "opencode", ext: "webp" }, opencodego: { file: "opencode-go", ext: "webp" },
  "google-antigravity": { file: "antigravity", ext: "svg" }, antigravity: { file: "antigravity", ext: "svg" }, blackbox: { file: "blackbox", ext: "svg" }, blackboxai: { file: "blackbox", ext: "svg" }, grok: { file: "grok", ext: "svg" }, "grok-build": { file: "grok-build", ext: "svg" },
};
function assetFor(icon: string): { file: string; ext: "svg" | "webp" } { return iconAssets[icon] ?? { file: icon, ext: "webp" }; }
function initialsOf(name: string): string { const words = name.trim().split(/[\s-]+/).filter(Boolean); return words.length >= 2 ? (words[0]![0]! + words[1]![0]!).toUpperCase() : name.slice(0, 2).toUpperCase(); }

export function ProviderIcon(props: { icon: string; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = createSignal(failedIcons.has(props.icon));
  const asset = () => assetFor(props.icon);
  const markFailed = () => { failedIcons.add(props.icon); setFailed(true); };
  return <div class={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] bg-[var(--surface-muted)]", props.className)} role="img" aria-label={`${props.name} provider`} style={{ width: `${props.size ?? 32}px`, height: `${props.size ?? 32}px` }}>
    {failed() ? <span aria-hidden="true" class="text-[11px] font-bold tracking-tight text-[var(--text-secondary)]">{initialsOf(props.name)}</span> : <img src={`${import.meta.env.BASE_URL}providers/${asset().file}.${asset().ext}`} alt="" width={props.size ?? 32} height={props.size ?? 32} class="h-full w-full object-contain" onError={markFailed} />}
  </div>;
}
