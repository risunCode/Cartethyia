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
      className="mlab-composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      {images.length > 0 ? (
        <div className="mlab-attachments">
          {images.map((image) => (
            <span key={image.dataUrl} className="mlab-attachment">
              <img src={image.dataUrl} alt="" />
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => onImages(images.filter((item) => item.dataUrl !== image.dataUrl))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        ref={fieldRef}
        className="mlab-composer-input"
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
      <div className="mlab-composer-bar">
        <div className="mlab-composer-tools">
          <button
            type="button"
            className="mlab-tool"
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
            className="mlab-model-chip font-mono tabular-nums"
            onClick={() => setPickerOpen(true)}
          >
            {model.length > 0 ? modelName(model) : "Pick model"}
          </Button>


          <span className="mlab-effort">
            <Brain size={13} />
            <Select
              size="sm"
              aria-label="Reasoning effort"
              value={effort}
              options={EFFORTS}
              onValueChange={(next) => onEffort(next as LabEffort)}
            />
          </span>
        </div>
        <div className="mlab-composer-actions">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            title={sessionTitle}
            className="mlab-model-chip"
            onClick={onOpenSessions}
          >
            {sessionTitle}
          </Button>
          <button type="button" className="mlab-tool mlab-settings-btn" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
            <SlidersHorizontal size={15} />
            <span>Settings</span>
          </button>
          {sending ? (
            <button type="button" className="mlab-send" aria-label="Stop" onClick={onStop}>
              <Square size={13} fill="currentColor" />
              <span>Stop</span>
            </button>
          ) : (
            <button type="submit" className="mlab-send" aria-label="Send" disabled={!canSend}>
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
