import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Drawer } from "../../components/ui/drawer";
import { Input, Textarea } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import type { LabDraft } from "./session";

const PROTOCOLS = [
  { value: "chat", label: "Chat completions" },
  { value: "responses", label: "Responses" },
  { value: "messages", label: "Messages" },
] as const;

const MODES = [
  { value: "agentic", label: "Agentic" },
  { value: "media", label: "Media generation" },
] as const;

/**
 * Request detail, split so the everyday choice is not mixed with overrides.
 *
 * Mode and protocol are always visible. Temperature, Top P, and the system
 * prompt override the model default, so they stay collapsed until asked for.
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <Drawer open={open} onClose={onClose} title="Request detail">
      <div className="mlab-settings">
        <section className="mlab-settings-section">
          <h3>Request</h3>
          <Select
            label="Mode"
            aria-label="Chat mode"
            value={draft.mode}
            options={MODES}
            onValueChange={(mode) => onChange({ mode: mode as LabDraft["mode"] })}
          />
          <Select
            label="Chat protocol"
            aria-label="Chat protocol"
            value={draft.protocol}
            options={PROTOCOLS}
            onValueChange={(protocol) => onChange({ protocol: protocol as LabDraft["protocol"] })}
          />
        </section>

        <section className="mlab-settings-section">
          <button
            type="button"
            className="mlab-advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((current) => !current)}
          >
            <span>Advanced</span>
            <ChevronDown size={14} data-open={advancedOpen ? "true" : "false"} />
          </button>
          {advancedOpen ? (
            <div className="mlab-advanced">
              <p className="mlab-settings-note">Empty fields leave the model default alone.</p>
              <div className="mlab-settings-pair">
                <Input
                  label="Temperature"
                  hint="override"
                  inputMode="decimal"
                  value={draft.temperature}
                  placeholder="0.7"
                  onChange={(event) => onChange({ temperature: event.target.value })}
                />
                <Input
                  label="Top P"
                  hint="override"
                  inputMode="decimal"
                  value={draft.topP}
                  placeholder="1"
                  onChange={(event) => onChange({ topP: event.target.value })}
                />
              </div>
              <Textarea
                label="System prompt"
                hint="override"
                rows={6}
                value={draft.systemPrompt}
                placeholder="Optional instructions sent ahead of the conversation."
                onChange={(event) => onChange({ systemPrompt: event.target.value })}
              />
            </div>
          ) : null}
        </section>
      </div>
    </Drawer>
  );
}
