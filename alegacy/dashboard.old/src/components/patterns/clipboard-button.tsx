import { Check, Copy } from "lucide-react";
import { Button, type ButtonProps } from "../ui/button";
import { useClipboard } from "../../composables/browser/use-clipboard";
import { toast } from "../../lib/toast";

export interface ClipboardButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
  value: string;
  label?: string;
  copiedLabel?: string;
  unavailableMessage?: string;
}

/** Copies a value with consistent feedback for secure and insecure origins. */
export function ClipboardButton({ value, label = "Copy", copiedLabel = "Copied", unavailableMessage = "Clipboard unavailable on this origin", ...props }: ClipboardButtonProps) {
  const { copied, copy } = useClipboard();
  const handleCopy = async () => {
    const ok = await copy(value);
    if (!ok) toast.error(unavailableMessage);
  };

  return (
    <Button {...props} onClick={() => void handleCopy()}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? copiedLabel : label}
    </Button>
  );
}
