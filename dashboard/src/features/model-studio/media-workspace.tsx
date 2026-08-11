import { useRef, useState } from "react";
import { Crop, Download, Image as ImageIcon, Layers, Loader2, RefreshCw, Sparkles, Trash2, Video, X } from "lucide-react";
import { apiPost } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { cn } from "../../lib/cn";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Tabs } from "../../components/ui/tabs";
import { ConfiguredModelPicker, type ModelPickerCapability } from "../../components/model-picker";

export type StudioMediaType = "image" | "video";

export interface StudioMediaResult {
  id: string;
  type: StudioMediaType;
  model: string;
  prompt: string;
  urls: string[];
  aspectRatio: string;
  count: number;
  createdAt: string;
}

interface MediaResponseItem {
  url?: string;
  b64_json?: string;
  mime_type?: string;
}

interface MediaWorkspaceProps {
  type: StudioMediaType;
  model: string;
  results: StudioMediaResult[];
  onTypeChange: (type: StudioMediaType) => void;
  onModelChange: (model: string) => void;
  onResultsChange: (results: StudioMediaResult[]) => void;
}

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "5:4", "4:5", "2:1"] as const;

function resultUrls(items: MediaResponseItem[], type: StudioMediaType): string[] {
  return items.flatMap((item) => {
    if (typeof item.url === "string" && item.url.length > 0) return [item.url];
    if (typeof item.b64_json !== "string" || item.b64_json.length === 0) return [];
    const mimeType = item.mime_type ?? (type === "video" ? "video/mp4" : "image/png");
    return [`data:${mimeType};base64,${item.b64_json}`];
  });
}

function mediaLabel(type: StudioMediaType): string {
  return type === "video" ? "Video" : "Image";
}

function capabilityFor(type: StudioMediaType): ModelPickerCapability {
  return type;
}

function downloadMedia(url: string, result: StudioMediaResult, index: number): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `model-studio-${result.type}-${result.id}-${index + 1}.${result.type === "video" ? "mp4" : "png"}`;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function MediaWorkspace({ type, model, results, onTypeChange, onModelChange, onResultsChange }: MediaWorkspaceProps) {
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<string>("1:1");
  const [count, setCount] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultScrollRef = useRef<HTMLDivElement>(null);

  const generate = async (inputPrompt = prompt.trim(), selectedModel = model, selectedType = type, selectedCount = count, selectedAspectRatio = aspectRatio) => {
    if (!inputPrompt || !selectedModel || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const response = await apiPost<{ data?: MediaResponseItem[] }>("/model-studio/media", {
        model: selectedModel,
        type: selectedType,
        prompt: inputPrompt,
        n: selectedType === "image" ? selectedCount : 1,
        ...(selectedType === "image" ? { aspectRatio: selectedAspectRatio } : {}),
      });
      const urls = resultUrls(response.data ?? [], selectedType);
      if (urls.length === 0) throw new Error(`The ${mediaLabel(selectedType).toLowerCase()} generation returned no media.`);
      onResultsChange([
        ...results,
        {
          id: crypto.randomUUID(),
          type: selectedType,
          model: selectedModel,
          prompt: inputPrompt,
          urls,
          aspectRatio: selectedAspectRatio,
          count: selectedType === "image" ? selectedCount : 1,
          createdAt: new Date().toISOString(),
        },
      ]);
      setPrompt("");
    } catch (requestError) {
      setError(getErrorMessage(requestError, `${mediaLabel(selectedType)} generation failed`));
    } finally {
      setGenerating(false);
    }
  };

  const regenerate = (result: StudioMediaResult) => void generate(result.prompt, result.model, result.type, result.count, result.aspectRatio);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-2 sm:gap-4 sm:p-3 lg:grid-cols-[minmax(280px,2fr)_minmax(0,3fr)]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)]" aria-label="Media generation controls">
        <div className="border-b border-[var(--inner-border)] px-3 py-3 sm:px-4">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]"><Sparkles size={14} /></span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--text-1)]">Media Studio</h2>
              <p className="text-[10px] text-[var(--text-3)]">Generate images and video with supported models.</p>
            </div>
          </div>
        </div>

        <div className="space-y-3 overflow-y-auto p-3 sm:p-4">
          <Tabs tabs={[{ id: "image", label: "Image" }, { id: "video", label: "Video" }]} value={type} onChange={(value) => { const next = value as StudioMediaType; onTypeChange(next); if (next === "video") setCount(1); }} />

          <label className="block text-[11px] font-semibold text-[var(--text-2)]">
            Model
            <ConfiguredModelPicker value={model} onChange={onModelChange} capability={capabilityFor(type)} placeholder={`Select ${mediaLabel(type).toLowerCase()} model…`} />
          </label>

          <label className="block text-[11px] font-semibold text-[var(--text-2)]" htmlFor="model-studio-media-prompt">
            Prompt
            <textarea id="model-studio-media-prompt" name="media-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={type === "video" ? "Describe the video you want…" : "Describe the image you want…"} rows={5} className="mt-1.5 w-full resize-y rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]" />
          </label>

          {type === "image" && (
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[11px] font-semibold text-[var(--text-2)]" htmlFor="model-studio-media-count">
                <span className="flex items-center gap-1"><Layers size={12} /> Images</span>
                <select id="model-studio-media-count" name="media-count" value={count} onChange={(event) => setCount(Number(event.target.value))} className="mt-1.5 h-8 w-full rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-xs text-[var(--text-1)] outline-none focus:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]">
                  {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="block text-[11px] font-semibold text-[var(--text-2)]" htmlFor="model-studio-media-aspect">
                <span className="flex items-center gap-1"><Crop size={12} /> Aspect ratio</span>
                <select id="model-studio-media-aspect" name="media-aspect" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} className="mt-1.5 h-8 w-full rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-xs text-[var(--text-1)] outline-none focus:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]">
                  {ASPECT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
          )}

          {error && <div role="alert" className="rounded-lg border border-[var(--red)]/30 bg-[var(--red-soft)] px-3 py-2 text-[11px] text-[var(--red)]">{error}</div>}
          <Button className="w-full gap-2" onClick={() => void generate()} disabled={generating || !prompt.trim() || !model.trim()}>
            {generating ? <><Loader2 size={14} className="animate-spin" /> Generating…</> : <><Sparkles size={14} /> Generate {mediaLabel(type)}</>}
          </Button>
          {!model.trim() && <p className="text-center text-[10px] text-[var(--text-3)]">Select a supported {mediaLabel(type).toLowerCase()} model to continue.</p>}
        </div>
      </section>

      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--surface-1)]" aria-label="Generated media preview">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--inner-border)] px-3 py-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--green-soft)] text-[var(--green)]">{type === "video" ? <Video size={14} /> : <ImageIcon size={14} />}</span>
            <div className="min-w-0"><h2 className="text-sm font-semibold text-[var(--text-1)]">Preview</h2><p className="text-[10px] text-[var(--text-3)]">{results.length === 0 ? "No generated media yet" : `${results.length} generation${results.length === 1 ? "" : "s"}`}</p></div>
          </div>
          {results.length > 0 && <Button variant="ghost" size="sm" className="gap-1.5 text-[var(--text-3)] hover:text-[var(--red)]" onClick={() => onResultsChange([])}><Trash2 size={13} /> Clear</Button>}
        </div>
        <div ref={resultScrollRef} className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {results.length === 0 && !generating && <div className="flex h-full min-h-48 flex-col items-center justify-center text-center"><span className="mb-3 grid h-14 w-14 place-items-center rounded-2xl border border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-3)]">{type === "video" ? <Video size={24} /> : <ImageIcon size={24} />}</span><p className="text-sm font-medium text-[var(--text-1)]">Gallery is empty</p><p className="mt-1 max-w-xs text-[11px] leading-relaxed text-[var(--text-3)]">Generate from the controls to preview supported media here.</p></div>}
          <div className="space-y-4">
            {results.map((result) => <article key={result.id} className="overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--hover)]"><div className="flex items-start justify-between gap-3 border-b border-[var(--inner-border)] p-3"><div className="min-w-0"><p className="line-clamp-2 text-[11px] leading-relaxed text-[var(--text-1)]">{result.prompt}</p><div className="mt-1.5 flex flex-wrap items-center gap-1.5"><Badge tone={result.type === "video" ? "warn" : "accent"}>{result.type === "video" ? <Video size={10} className="mr-1" /> : <ImageIcon size={10} className="mr-1" />}{result.type}</Badge><span className="text-[10px] text-[var(--text-3)]">{result.model}</span><span className="font-mono text-[10px] text-[var(--text-3)]">{result.aspectRatio}</span></div></div><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => regenerate(result)} disabled={generating} aria-label="Regenerate media" title="Regenerate" className="rounded-md p-1.5 text-[var(--text-3)] transition-colors hover:bg-[var(--active-pill)] hover:text-[var(--text-1)] disabled:opacity-50"><RefreshCw size={13} /></button><button type="button" onClick={() => onResultsChange(results.filter((entry) => entry.id !== result.id))} aria-label="Delete media" title="Delete" className="rounded-md p-1.5 text-[var(--text-3)] hover:bg-[var(--red-soft)] hover:text-[var(--red)]"><X size={13} /></button></div></div><div className={cn("grid gap-2 p-3", result.urls.length > 1 ? "grid-cols-2" : "grid-cols-1")}>{result.urls.map((url, index) => <div key={`${result.id}-${index}`} className="group relative overflow-hidden rounded-lg border border-[var(--inner-border)] bg-[var(--surface-1)]" style={result.type === "image" ? { aspectRatio: result.aspectRatio.replace(":", " / ") } : undefined}>{result.type === "video" ? <video src={url} controls width={768} height={432} className="h-full min-h-40 w-full object-cover" /> : <img src={url} alt={`Generated image ${index + 1}`} width={768} height={768} loading="lazy" className="h-full w-full object-cover" /> }<button type="button" onClick={() => downloadMedia(url, result, index)} aria-label={`Download ${result.type} ${index + 1}`} title="Download" className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-lg bg-black/70 text-white opacity-0 transition-opacity hover:bg-black group-hover:opacity-100"><Download size={14} /></button></div>)}</div></article>)}
            {generating && <div role="status" aria-live="polite" className="rounded-xl border border-dashed border-[var(--accent)]/40 bg-[var(--accent-soft)] p-8 text-center"><Loader2 size={26} className="mx-auto animate-spin text-[var(--accent)]" /><p className="mt-2 text-sm font-medium text-[var(--text-1)]">Generating {type}…</p><p className="mt-1 text-[11px] text-[var(--text-3)]">The upstream is preparing your media.</p></div>}
          </div>
        </div>
      </section>
    </div>
  );
}
