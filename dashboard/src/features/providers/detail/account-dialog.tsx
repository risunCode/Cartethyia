/* @jsxImportSource solid-js */

import { createSignal } from "solid-js";
import { toast } from "../../../lib/toast";
import { consolePost } from "../../../lib/console-api";
import { errorMessage } from "../detail-helpers";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Input, Label } from "../../../components/ui/input";
import type { AccountEntry } from "./types";

export function AccountDialog(props: { providerId: string; account: AccountEntry | null; expectedKind: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = createSignal(props.account?.name ?? `${props.providerId}-${Date.now() % 1000}`);
  const [credentialRef, setCredentialRef] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const save = async () => {
    if (!name().trim() || (!props.account && !credentialRef().trim())) return;
    setBusy(true);
    try {
      if (props.account) {
        await consolePost(`/providers/${encodeURIComponent(props.providerId)}/accounts/${encodeURIComponent(props.account.id)}`, {
          label: name().trim(),
          ...(credentialRef().trim() ? { credentialRef: credentialRef().trim() } : {}),
          enabled: true,
        });
      } else {
        await consolePost(`/providers/${encodeURIComponent(props.providerId)}/accounts`, {
          label: name().trim(),
          credentialRef: credentialRef().trim(),
          credentialKind: props.expectedKind,
          enabled: true,
        });
      }
      toast.success(props.account ? "Account updated" : "Account added");
      props.onSaved();
      props.onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={props.account ? `Edit ${props.account.name}` : "Add connection"}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button disabled={busy() || !name().trim() || (!props.account && !credentialRef().trim())} onClick={() => void save()}>
            {busy() ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div class="space-y-3">
        <div>
          <Label>Name</Label>
          <Input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </div>
        <div>
          <Label>Opaque credentialRef ({props.expectedKind})</Label>
          <textarea
            value={credentialRef()}
            onInput={(event) => setCredentialRef(event.currentTarget.value)}
            class="min-h-24 w-full rounded-xl border border-[var(--inner-border)] bg-[var(--input-bg)] px-3 py-2 font-mono text-xs"
            spellcheck={false}
          />
        </div>
      </div>
    </Dialog>
  );
}
