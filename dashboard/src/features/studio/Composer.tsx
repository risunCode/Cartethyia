import { Brain, Paperclip, Send, SlidersHorizontal, Square, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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
  effortDisabled,
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
  readonly effortDisabled?: boolean;
  readonly sending: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly onOpenSettings: () => void;
}) : ReactNode {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    field.style.height = "0px";
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }, [value]);

  const addFiles = async (list: FileList | null) => {
    if (list === null || list.length === 0) return;
    const room = MAX_IMAGES - images.length;
    const files = [...list].filter((file) => file.type.startsWith("image/")).slice(0, room);
    if (files.length === 0) return;
    const next = await Promise.all(files.map(readImage));
    onImages([...images, ...next]);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <form
      className="composer-glass flex flex-col gap-4 px-7 pt-7 pb-5 border border-inner-border rounded-composer shadow-composer outline-none transition-none max-small:gap-3 max-small:px-4 max-small:pt-4 max-small:pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-4 px-2 max-small:gap-3">
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
        className="scroll-region w-full min-h-14 max-h-80 resize-none overflow-x-hidden border-0 outline-none bg-transparent text-text-primary font-sans text-lead leading-normal px-2 py-1 placeholder:text-text-tertiary"
        rows={1}
        wrap="soft"
        value={value}
        placeholder={model.length > 0 ? `Message ${model}...` : "Message..."}
        aria-label="Message"
        onChange={(event) => {
          onChange(event.target.value);
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
      <div className="flex items-center justify-between gap-4 max-small:grid max-small:grid-cols-1 max-small:gap-2">
        <div className="flex items-center gap-3 min-w-0 max-small:flex-nowrap max-small:gap-2">
          <button
            type="button"
            className="w-16 h-16 grid place-items-center border-0 rounded-pill bg-transparent text-text-secondary cursor-pointer hover:bg-hover hover:text-text-primary disabled:opacity-40 max-small:shrink-0"
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
            className="studio-model-picker max-w-110 h-15 px-5 border border-inner-border rounded-control bg-hover text-caption font-semibold hover:border-border-strong hover:bg-active-pill font-mono tabular-nums [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap max-small:w-fit max-small:min-w-0 max-small:flex-none max-small:h-auto max-small:min-h-15 max-small:py-2 max-small:px-3 max-small:text-center max-small:leading-tight max-small:[&>span]:w-fit max-small:[&>span]:max-w-full max-small:[&>span]:whitespace-normal max-small:[&>span]:break-words max-small:[&>span]:text-center"
            onClick={() => setPickerOpen(true)}
          >
            {model.length > 0 ? modelName(model) : "Pick model"}
          </Button>


          <span className="inline-flex items-center gap-2 h-15 pl-4 pr-1 border border-inner-border rounded-control bg-hover text-text-secondary max-small:shrink-0">
            <Brain size={13} />
            <Select
              size="sm"
              aria-label="Reasoning effort"
              value={effort}
              options={EFFORTS}
              onValueChange={(next) => onEffort(next as LabEffort)}
              disabled={effortDisabled}
              className="h-13 min-w-29 w-auto px-4 border-0 bg-transparent text-caption hover:bg-active-pill [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap"
            />
          </span>
        </div>
        <div className="flex items-center gap-3 min-w-0 max-small:w-auto max-small:justify-end max-small:justify-self-end max-small:gap-2">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            title={sessionTitle}
            className="max-w-110 h-15 px-5 border border-inner-border rounded-control bg-hover text-caption font-semibold hover:border-border-strong hover:bg-active-pill [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap max-small:min-w-0 max-small:max-w-45 max-small:px-3"
            onClick={onOpenSessions}
          >
            {sessionTitle}
          </Button>
          <button type="button" className="hidden max-medium:inline-flex w-auto items-center h-15 px-5 gap-3 border border-inner-border rounded-control bg-hover text-text-primary text-caption font-semibold hover:border-border-strong hover:bg-active-pill max-small:px-3 max-small:gap-2" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
            <SlidersHorizontal size={15} />
            <span>Settings</span>
          </button>
          {sending ? (
            <button type="button" className="w-auto min-w-36 h-15 inline-flex items-center justify-center gap-3 px-6 border-0 rounded-control bg-text-primary text-surface-1 text-caption font-semibold cursor-pointer disabled:opacity-35 disabled:cursor-default active:scale-95 max-small:px-4 max-small:gap-2" aria-label="Stop" onClick={onStop}>
              <Square size={13} fill="currentColor" />
              <span>Stop</span>
            </button>
          ) : (
            <button type="submit" className="w-auto min-w-36 h-15 inline-flex items-center justify-center gap-3 px-6 border-0 rounded-control bg-text-primary text-surface-1 text-caption font-semibold cursor-pointer disabled:opacity-35 disabled:cursor-default active:scale-95 max-small:px-4 max-small:gap-2" aria-label="Send" disabled={!canSend}>
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
        size="md"
      />
    </form>
  );
}
