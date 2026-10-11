import { Brain, Paperclip, Send, SlidersHorizontal, Square, X } from "lucide-react";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ModelPickerModal } from "../../components/ModelPicker";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import type { LabEffort, LabImage } from "./protocol";

const EFFORTS: readonly { readonly value: LabEffort; readonly label: string }[] = [
  { value: "auto", label: "auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];



const MAX_IMAGES = 4;

function modelName(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

function readImage(file: File): Promise<LabImage> {
  const { promise, resolve, reject } = Promise.withResolvers<LabImage>();
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== "string") reject(new Error("Could not read that image"));
    else resolve({ name: file.name, dataUrl: reader.result });
  };
  reader.onerror = () => reject(new Error("Could not read that image"));
  reader.readAsDataURL(file);
  return promise;
}

/**
 * The docked composer. The model is picked here, once, through the same
 * catalog modal the rest of the console uses. Mode lives in request settings.
 * Effort stays on the tool row because it changes per turn.
 */
export function Composer({
  model,
  onModel,
  sessionTitle,
  onOpenSessions,
  value,
  onChange,
  images,
  onImages,
  effort,
  onEffort,
  sending,
  canSend,
  onSend,
  onStop,
  onOpenSettings,
}: {
  readonly model: string;
  readonly onModel: (model: string) => void;
  readonly sessionTitle: string;
  readonly onOpenSessions: () => void;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly images: readonly LabImage[];
  readonly onImages: (images: readonly LabImage[]) => void;
  readonly effort: LabEffort;
  readonly onEffort: (value: LabEffort) => void;
  readonly sending: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onOpenSettings: () => void;
}) : ReactNode {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const addFiles = async (list: FileList | null) => {
    if (list === null || list.length === 0) return;
    const room = MAX_IMAGES - images.length;
    const files = [...list].filter((file) => file.type.startsWith("image/")).slice(0, room);
    if (files.length === 0) return;
    const next = await Promise.all(files.map(readImage));
    onImages([...images, ...next]);
  };

  const grow = () => {
    const field = fieldRef.current;
    if (field === null) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <form
      className="composer-glass flex flex-col gap-4 px-7 pt-7 pb-5 border border-inner-border rounded-composer shadow-composer outline-none transition-none"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      {images.length > 0 ? (
        <div className="flex gap-4 px-2">
          {images.map((image) => (
            <span key={image.dataUrl} className="relative">
              <img src={image.dataUrl} alt="" className="block w-36 h-36 object-cover rounded-control" />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => onImages(images.filter((item) => item.dataUrl !== image.dataUrl))}
                className="absolute -top-3 -right-3 w-9 h-9 grid place-items-center border-0 rounded-pill bg-text-primary text-surface-1 cursor-pointer"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        ref={fieldRef}
        className="w-full min-h-14 max-h-80 resize-none border-0 outline-none bg-transparent text-text-primary font-sans text-lead leading-normal px-2 py-1 placeholder:text-text-tertiary"
        rows={1}
        value={value}
        placeholder={model.length > 0 ? `Message ${model}...` : "Message..."}
        aria-label="Message"
        onChange={(event) => {
          onChange(event.target.value);
          grow();
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
          if (files.length === 0) return;
          event.preventDefault();
          const transfer = new DataTransfer();
          for (const file of files) transfer.items.add(file);
          void addFiles(transfer.files);
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        aria-label="Attach images"
        onChange={(event) => {
          void addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            className="w-16 h-16 grid place-items-center border-0 rounded-pill bg-transparent text-text-secondary cursor-pointer hover:bg-hover hover:text-text-primary disabled:opacity-40"
            aria-label="Attach an image"
            title="Attach an image"
            disabled={images.length >= MAX_IMAGES}
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip size={16} />
          </button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            title={model.length > 0 ? model : "Pick model"}
            className="max-w-110 h-15 px-5 border border-inner-border rounded-control bg-hover text-caption font-semibold hover:border-border-strong hover:bg-active-pill font-mono tabular-nums [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap"
            onClick={() => setPickerOpen(true)}
          >
            {model.length > 0 ? modelName(model) : "Pick model"}
          </Button>


          <span className="inline-flex items-center gap-2 h-15 pl-4 pr-1 border border-inner-border rounded-control bg-hover text-text-secondary">
            <Brain size={13} />
            <Select
              size="sm"
              aria-label="Reasoning effort"
              value={effort}
              options={EFFORTS}
              onValueChange={(next) => onEffort(next as LabEffort)}
              className="h-13 min-w-29 w-auto px-4 border-0 bg-transparent text-caption hover:bg-active-pill [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap"
            />
          </span>
        </div>
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            title={sessionTitle}
            className="max-w-110 h-15 px-5 border border-inner-border rounded-control bg-hover text-caption font-semibold hover:border-border-strong hover:bg-active-pill [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap"
            onClick={onOpenSessions}
          >
            {sessionTitle}
          </Button>
          <button type="button" className="w-auto inline-flex items-center h-15 px-5 gap-3 border border-inner-border rounded-control bg-hover text-text-primary text-caption font-semibold hover:border-border-strong hover:bg-active-pill" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
            <SlidersHorizontal size={15} />
            <span>Settings</span>
          </button>
          {sending ? (
            <button type="button" className="w-auto min-w-36 h-15 inline-flex items-center justify-center gap-3 px-6 border-0 rounded-control bg-text-primary text-surface-1 text-caption font-semibold cursor-pointer disabled:opacity-35 disabled:cursor-default active:scale-95" aria-label="Stop" onClick={onStop}>
              <Square size={13} fill="currentColor" />
              <span>Stop</span>
            </button>
          ) : (
            <button type="submit" className="w-auto min-w-36 h-15 inline-flex items-center justify-center gap-3 px-6 border-0 rounded-control bg-text-primary text-surface-1 text-caption font-semibold cursor-pointer disabled:opacity-35 disabled:cursor-default active:scale-95" aria-label="Send" disabled={!canSend}>
              <Send size={15} />
              <span>Send</span>
            </button>
          )}
        </div>
      </div>
      <ModelPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selected={model.length > 0 ? [model] : []}
        onToggle={() => {}}
        onSelectOne={onModel}
        multi={false}
        title="Select chat model"
      />
    </form>
  );
}
