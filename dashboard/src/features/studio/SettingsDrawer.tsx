import { useEffect, useState, type ReactNode } from "react";
import { Drawer } from "../../components/ui/drawer";
import { Input, Textarea } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import type { LabDraft } from "./session";

const PROTOCOLS = [
  { value: "chat", label: "Chat completions" },
  { value: "responses", label: "Responses" },
  { value: "messages", label: "Messages" },
] as const;

const PERSONAS = [
  { value: "cartethyia", label: "Cartethyia" },
  { value: "unset", label: "None" },
] as const;

/**
 * Chat settings stay inside the Model Lab card on desktop and use a drawer on mobile.
 *
 * Protocol and advanced overrides are always visible.
 * The model itself is picked on the composer, and the key is always the
 * tenant default.
 */
export function SettingsDrawer({
  open,
  onClose,
  draft,
  onChange,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly draft: LabDraft;
  readonly onChange: (patch: Partial<LabDraft>) => void;
}): ReactNode {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const controls = (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-5">
        <h3 className="m-0 text-caption font-bold tracking-label uppercase text-text-tertiary">Request</h3>
        <Select
          label="Chat protocol"
          aria-label="Chat protocol"
          value={draft.protocol}
          options={PROTOCOLS}
          onValueChange={(protocol) => onChange({ protocol: protocol as LabDraft["protocol"] })}
        />
        <Select
          label="Persona"
          aria-label="Persona"
          value={draft.persona}
          options={PERSONAS}
          onValueChange={(persona) => onChange({ persona: persona as LabDraft["persona"] })}
        />
      </section>

      <section className="flex flex-col gap-5">
        <h3 className="m-0 text-caption font-bold tracking-label uppercase text-text-primary">Advanced</h3>
        <div className="flex flex-col gap-6">
          <p className="m-0 text-text-tertiary text-caption leading-normal">Empty fields leave the model default alone.</p>
          <div className="grid grid-cols-2 gap-5 max-medium:grid-cols-1">
            <Input
              label="Temperature"
              inputMode="decimal"
              value={draft.temperature}
              placeholder="0.7"
              onChange={(event) => onChange({ temperature: event.target.value })}
            />
            <Input
              label="Top P"
              inputMode="decimal"
              value={draft.topP}
              placeholder="1"
              onChange={(event) => onChange({ topP: event.target.value })}
            />
          </div>
          <Textarea
            label="System prompt"
            rows={6}
            value={draft.systemPrompt}
            placeholder="Optional instructions sent ahead of the conversation."
            onChange={(event) => onChange({ systemPrompt: event.target.value })}
          />
        </div>
      </section>
    </div>
  );

  return (
    <>
      <aside className="flex-none w-128 min-h-0 overflow-y-auto border-l border-inner-border px-7 py-8 max-medium:hidden">
        <h2 className="m-0 mb-7 text-lead font-semibold text-text-primary">Chat settings</h2>
        {controls}
      </aside>
      <Drawer open={open && isMobile} onClose={onClose} title="Chat settings">{controls}</Drawer>
    </>
  );
}
