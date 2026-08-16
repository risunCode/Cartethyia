
import { Check, Copy } from "lucide-solid";
import { splitProps } from "solid-js";
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
export function ClipboardButton(props: ClipboardButtonProps) {
  const [local, rest] = splitProps(props, ["value", "label", "copiedLabel", "unavailableMessage"]);
  const { copied, copy } = useClipboard();
  const handleCopy = async () => {
    const ok = await copy(local.value);
    if (!ok) toast.error(local.unavailableMessage ?? "Clipboard unavailable on this origin");
  };

  return (
    <Button {...rest} onClick={() => void handleCopy()}>
      {copied() ? <Check size={13} /> : <Copy size={13} />}
      {copied() ? local.copiedLabel ?? "Copied" : local.label ?? "Copy"}
    </Button>
  );
}
