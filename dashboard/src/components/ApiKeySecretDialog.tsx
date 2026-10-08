import { Download } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { ClipboardButton } from "./patterns/clipboard-button";
import { downloadTextFile } from "../lib/download";
import { toast } from "../lib/toast";

/**
 * The one-time reveal of a freshly generated key secret.
 *
 * The console returns a plaintext secret exactly once — when a key is created,
 * when an edit rotates its credential, and when it is regenerated from the row
 * or from its share dialog — and the list endpoint never carries it again. Every
 * one of those paths funnels the plaintext here so there is a single, blocking
 * surface to copy or download it. A reveal that only appeared inline could be
 * scrolled out of view, and a rotate that surfaced nothing left the operator
 * holding a credential they could not read.
 */
export function ApiKeySecretDialog({
  secret,
  onClose,
}: {
  readonly secret: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const download = () => {
    if (secret === null) return;
    downloadTextFile(
      "cartethyia-api-key.txt",
      `Cartethyia API key\n\n${secret}\n\nKeep this secret. Reveal it again from the key's Share button.\n`,
      "text/plain;charset=utf-8",
    );
    toast.success("Key saved to your downloads.");
  };

  return (
    <Dialog
      open={secret !== null}
      onClose={onClose}
      title="New API key"
      description="Copy it now, or reveal it again later from the key's Share button."
      size="md"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5, margin: 0 }}>
          A personal key stays recoverable. Open the key's Share button and choose
          Reveal to see it again and copy it. Rotating the key replaces this secret,
          and any client still using it starts getting 401s.
        </p>
        <code
          style={{
            display: "block",
            padding: "10px 12px",
            borderRadius: "8px",
            background: "var(--surface-1)",
            border: "1px solid var(--inner-border)",
            fontSize: "12px",
            wordBreak: "break-all",
            color: "var(--text-primary)",
          }}
        >
          {secret}
        </code>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <ClipboardButton
            value={secret ?? ""}
            size="sm"
            variant="primary"
            label="Copy key"
            copiedLabel="Copied"
          />
          <Button variant="secondary" size="sm" icon={<Download size={13} />} onClick={download}>
            Save this key
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
