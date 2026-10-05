import { Loader2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { Stack } from "../../components/ui/stack";
import { useImportOAuthCredential } from "../../hooks/providers";
import { toast } from "../../shared/toast";

/**
 * One operator-supplied value a login needs.
 *
 * Mirrors the server's `ProviderLoginField`. Declared here rather than imported
 * so the browser bundle does not reach into the provider layer to render a form.
 */
export interface LoginField {
  readonly key: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly defaultValue?: string;
}

/** Initial values for a field set, applying each field's declared default. */
export function initialFieldValues(fields: readonly LoginField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) values[field.key] = field.defaultValue ?? "";
  return values;
}

/**
 * The keys a field set marks required but that carry no value.
 *
 * Checked before a request is sent so an empty required field is reported in the
 * form rather than as a server-side rejection the operator cannot act on.
 */
export function missingRequiredFields(
  fields: readonly LoginField[],
  values: Readonly<Record<string, string>>,
): readonly string[] {
  return fields
    .filter((field) => field.required === true && (values[field.key] ?? "").trim().length === 0)
    .map((field) => field.key);
}

/**
 * Renders one declared field set.
 *
 * A field with `options` becomes a select; everything else is a text input, and
 * a `secret` field is masked. The shape comes from the provider, so a new
 * provider needs no dashboard change to get a working form.
 */
export function LoginFieldsForm({
  fields,
  values,
  onChange,
  idPrefix,
}: {
  readonly fields: readonly LoginField[];
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (key: string, value: string) => void;
  readonly idPrefix: string;
}): ReactNode {
  if (fields.length === 0) return null;
  return (
    <Stack gap="10px">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const value = values[field.key] ?? "";
        if (field.options && field.options.length > 0) {
          return (
            <Select
              key={field.key}
              id={id}
              label={field.label}
              value={value}
              onValueChange={(next) => onChange(field.key, next)}
              options={field.options.map((option) => ({ value: option.value, label: option.label }))}
            />
          );
        }
        return (
          <Input
            key={field.key}
            id={id}
            label={field.label}
            value={value}
            placeholder={field.placeholder ?? ""}
            type={field.secret === true ? "password" : "text"}
            autoComplete="off"
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        );
      })}
    </Stack>
  );
}

/**
 * Completes a login from credential material the operator already holds.
 *
 * Covers the families no redirect and no device code can reach: a pasted refresh
 * token, an exported enterprise auth blob, or a raw API key. The provider
 * declares which families it accepts and what else each one needs, so this
 * dialog renders whatever the selected provider states rather than knowing any
 * provider's specifics.
 */
export function ImportCredentialDialog({
  providerId,
  providerName,
  fields,
  onClose,
}: {
  readonly providerId: string;
  readonly providerName: string;
  readonly fields: readonly LoginField[];
  readonly onClose: () => void;
}): ReactNode {
  const importCredential = useImportOAuthCredential();
  const [credential, setCredential] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => initialFieldValues(fields));
  const missing = useMemo(() => missingRequiredFields(fields, values), [fields, values]);

  const submit = () => {
    if (credential.trim().length === 0) {
      toast.error("Credential required", "Paste the token, key or exported JSON to import.");
      return;
    }
    if (missing.length > 0) {
      toast.error("Missing required fields", `Fill in: ${missing.join(", ")}`);
      return;
    }
    importCredential.mutate(
      {
        providerId,
        credential: credential.trim(),
        ...(Object.keys(values).length > 0 ? { fields: values } : {}),
        ...(accountLabel.trim().length > 0 ? { accountLabel: accountLabel.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success("Account imported", "The credential was validated and saved");
          onClose();
        },
        onError: (err) =>
          toast.error(
            "Import failed",
            (err as { message?: string }).message ?? "The provider rejected this credential",
          ),
      },
    );
  };

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title={`Import a ${providerName} credential`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={importCredential.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={importCredential.isPending}
            icon={
              importCredential.isPending ? <Loader2 size={13} className="animate-spin" /> : undefined
            }
          >
            {importCredential.isPending ? "Validating…" : "Import"}
          </Button>
        </>
      }
    >
      <Stack gap="12px">
        <p className="oauth-hint">
          The credential is checked against {providerName} before it is saved, so one that no longer
          works is reported here instead of being stored.
        </p>
        <LoginFieldsForm
          fields={fields}
          values={values}
          idPrefix="import"
          onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
        />
        <Input
          id="import-account-label"
          label="Account label"
          hint="optional"
          value={accountLabel}
          placeholder={providerId}
          onChange={(event) => setAccountLabel(event.target.value)}
        />
        <Input
          id="import-credential"
          label="Credential"
          value={credential}
          placeholder="Paste the token, key, or exported JSON"
          type="password"
          autoComplete="off"
          onChange={(event) => setCredential(event.target.value)}
        />
      </Stack>
    </Dialog>
  );
}
