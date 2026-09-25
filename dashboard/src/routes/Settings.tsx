import { Eye, Shield } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Select } from "../components/ui/select";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { BackupPanel } from "../components/BackupPanel";
import { toast } from "../lib/toast";
import { useChangePassword } from "../lib/hooks/auth";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../lib/hooks/settings";
import { getErrorMessage } from "../lib/helpers";


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
      <Card>
        <CardHeader
          title="Privacy"
          subtitle="Control what request telemetry stores and shows"
          icon={<Eye size={16} />}
        />
        <CardBody>
          <Stack gap="14px">
            <div>
              <Select
                label="Telemetry payloads"
                id="privacy-payloads"
                value={settings.telemetryPayloads}
                onValueChange={(value) =>
                  mutation.mutate(
                    { telemetryPayloads: value === "none" ? "none" : "bounded" },
                    {
                      onError: (error) =>
                        toast.error(getErrorMessage(error, "Could not update payload capture.")),
                    },
                  )
                }
                options={[
                  { value: "none", label: "Off — metadata only (default)" },
                  { value: "bounded", label: "On — temporary bodies, pruned after 15 minutes" },
                ]}
              />
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Request metadata is always retained. Body capture is opt-in, redacted, and deleted
                automatically after 15 minutes.
              </p>
            </div>
            <div>
              <Select
                label="Client IP display"
                id="privacy-ip"
                value={settings.privacyMode}
                onValueChange={(value) =>
                  mutation.mutate(
                    { privacyMode: value === "full" ? "full" : "masked" },
                    {
                      onError: (error) =>
                        toast.error(getErrorMessage(error, "Could not update IP display.")),
                    },
                  )
                }
                options={[
                  { value: "masked", label: "Masked — recommended" },
                  { value: "full", label: "Show full IP" },
                ]}
              />
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Raw addresses stay in storage; only the presentation changes.
              </p>
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
    <Stack gap="10px">
      <Input
        id="current-password"
        label="Current password"
        type="password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        autoComplete="current-password"
      />
      <Input
        id="new-password"
        label="New password (min 8 characters)"
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        autoComplete="new-password"
      />
      <Input
        id="confirm-password"
        label="Confirm new password"
        type="password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        autoComplete="new-password"
      />
      {formError ? <p style={{ fontSize: "12px", color: "var(--red)" }}>{formError}</p> : null}
      {success ? (
        <p style={{ fontSize: "12px", color: "var(--green)" }}>Password updated successfully.</p>
      ) : null}
      <Inline justify="flex-end" style={{ marginTop: "4px" }}>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={
            changePassword.isPending || !currentPassword || !newPassword || !confirmPassword
          }
        >
          {changePassword.isPending ? "Updating…" : "Update Password"}
        </Button>
      </Inline>
    </Stack>
  );
}

export default function Settings(): ReactNode {
  return (
    <div className="settings-column">
      {/* Security Controls / Password Change */}
      <Card>
        <CardHeader
          title="Security Controls"
          subtitle="Manage console account credentials"
          icon={<Shield size={16} />}
        />
        <CardBody>
          <PasswordChangeForm />
        </CardBody>
      </Card>

      {/* Privacy */}
      <PrivacyPanel />

      {/* Backup & Restore */}
      <BackupPanel />
    </div>
  );
}
