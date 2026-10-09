import { Eye, Shield } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Select } from "../../components/ui/select";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Stack } from "../../components/ui/stack";
import { BackupPanel } from "../../components/BackupPanel";
import { toast } from "../../lib/toast";
import { useChangePassword } from "../../hooks/auth";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../../hooks/settings";
import { getErrorMessage } from "../../lib/helpers";


function PrivacyPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending) return <LoadingState label="Loading privacy settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(query.error, "Failed to load runtime settings")}
        onRetry={() => void query.refetch()}
      />
    );
  }


  return (
    <Card className="h-full">
      <CardHeader
        title="Privacy"
        subtitle="What request telemetry stores, and how client addresses are shown"
        icon={<Eye size={16} />}
      />
      <CardBody>
        <Stack gap="16px">
          <div className="settings-field">
            <Select
              label="Telemetry payloads"
              id="privacy-payloads"
              value={settings.telemetryPayloads}
              onValueChange={(value) =>
                mutation.mutate(
                  { telemetryPayloads: value === "full" || value === "metadata" ? value : "none" },
                  {
                    onSuccess: () => toast.success("Payload capture updated"),
                    onError: (error) => toast.error(getErrorMessage(error, "Could not update payload capture.")),
                  },
                )
              }
              options={[
                { value: "none", label: "Off — no payload capture" },
                { value: "metadata", label: "Metadata — method and headers, 15 minutes" },
                { value: "full", label: "Full — redacted bodies, 15 minutes" },
              ]}
            />
            <p className="form-section-caption">
              Request metadata is always kept. Bodies stay off until you turn them on, and anything captured is redacted and deleted after 15 minutes.
            </p>
          </div>
          {settings.telemetryPayloads === "full" ? (
            <div className="settings-field">
              <Select
                label="Capture depth"
                id="privacy-payload-depth"
                value={settings.telemetryPayloadDepth}
                onValueChange={(value) =>
                  mutation.mutate(
                    { telemetryPayloadDepth: value === "moderate" || value === "maximum" ? value : "minimum" },
                    {
                      onSuccess: () => toast.success("Capture depth updated"),
                      onError: (error) => toast.error(getErrorMessage(error, "Could not update capture depth.")),
                    },
                  )
                }
                options={[
                  { value: "minimum", label: "Minimum — 1 MiB cap" },
                  { value: "moderate", label: "Moderate — 8 MiB cap" },
                  { value: "maximum", label: "Maximum — 16 MiB cap" },
                ]}
              />
              {settings.telemetryPayloadDepth !== "minimum" ? (
                <div role="note" className="status-callout" data-tone="warn">
                  <strong>High CPU and memory while this is on.</strong> Use it to debug, then switch back to Metadata or Minimum.
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="settings-field">
            <Select
              label="Client IP display"
              id="privacy-ip"
              value={settings.privacyMode}
              onValueChange={(value) =>
                mutation.mutate(
                  { privacyMode: value === "full" ? "full" : "masked" },
                  {
                    onSuccess: () => toast.success("IP display updated"),
                    onError: (error) => toast.error(getErrorMessage(error, "Could not update IP display.")),
                  },
                )
              }
              options={[
                { value: "masked", label: "Masked — recommended" },
                { value: "full", label: "Show full IP" },
              ]}
            />
            <p className="form-section-caption">Raw addresses stay stored. This only changes how they are shown.</p>
          </div>
        </Stack>
      </CardBody>
    </Card>
  );
}

function PasswordChangeForm(): ReactNode {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const submit = () => {
    setSuccess(false);
    if (newPassword.length < 8) {
      setFormError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError("New password and confirmation do not match.");
      return;
    }
    setFormError(null);
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setSuccess(true);
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        },
        onError: (error) => setFormError(getErrorMessage(error, "Password change failed.")),
      },
    );
  };

  return (
    <Stack gap="12px" className="flex-1">
      <Input id="current-password" label="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" />
      <div className="settings-pair settings-pair-tight">
        <Input id="new-password" label="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        <Input id="confirm-password" label="Confirm new password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
      </div>
      {formError ? <p role="alert" className="settings-feedback" data-tone="err">{formError}</p> : null}
      {success ? <p role="status" className="settings-feedback" data-tone="ok">Password updated.</p> : null}
      <div className="mt-auto flex justify-end">
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={changePassword.isPending || !currentPassword || !newPassword || !confirmPassword}
        >
          {changePassword.isPending ? "Updating…" : "Update password"}
        </Button>
      </div>
    </Stack>
  );
}

export default function Settings(): ReactNode {
  return (
    <Stack gap="16px">
      <section className="flex flex-col gap-[10px]">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">Account</h2>
        <div className="two-column-grid">
          <Card className="h-full">
            <CardHeader title="Security" subtitle="Change the password used to sign in to this console" icon={<Shield size={16} />} />
            <CardBody className="flex flex-1 flex-col">
              <PasswordChangeForm />
            </CardBody>
          </Card>
          <PrivacyPanel />
        </div>
      </section>
      <section className="flex flex-col gap-[10px]">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">Data</h2>
        <BackupPanel />
      </section>
    </Stack>
  );
}
