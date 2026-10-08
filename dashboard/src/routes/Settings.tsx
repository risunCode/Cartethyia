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
import { toast } from "../shared/toast";
import { useChangePassword } from "../hooks/auth";
import { useRuntimeSettings, useUpdateRuntimeSettings } from "../hooks/settings";
import { getErrorMessage } from "../shared/helpers";


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
                    {
                      telemetryPayloads:
                        value === "full" || value === "metadata" ? value : "none",
                    },
                    {
                      onSuccess: () => toast.success("Payload capture updated"),
                      onError: (error) =>
                        toast.error(getErrorMessage(error, "Could not update payload capture.")),
                    },
                  )
                }
                options={[
                  {
                    value: "metadata",
                    label: "Metadata — Proxy→Provider method + headers (default), pruned after 15 minutes",
                  },
                  {
                    value: "full",
                    label: "Full — redacted bodies at the depth below, pruned after 15 minutes",
                  },
                  { value: "none", label: "Off — no payload capture" },
                ]}
              />
              {settings.telemetryPayloads === "full" ? (
                <div style={{ marginTop: "8px" }}>
                  <Select
                    label="Capture depth"
                    id="privacy-payload-depth"
                    value={settings.telemetryPayloadDepth}
                    onValueChange={(value) =>
                      mutation.mutate(
                        {
                          telemetryPayloadDepth:
                            value === "moderate" || value === "maximum" ? value : "minimum",
                        },
                        {
                          onSuccess: () => toast.success("Capture depth updated"),
                          onError: (error) =>
                            toast.error(getErrorMessage(error, "Could not update capture depth.")),
                        },
                      )
                    }
                    options={[
                      {
                        value: "minimum",
                        label: "Minimum — all four panels, 1 MiB cap (default)",
                      },
                      {
                        value: "moderate",
                        label: "Moderate — all four panels, 16 MiB cap",
                      },
                      {
                        value: "maximum",
                        label: "Maximum — all four panels, 32 MiB cap",
                      },
                    ]}
                  />
                </div>
              ) : null}
              {settings.telemetryPayloads === "full" &&
              settings.telemetryPayloadDepth !== "minimum" ? (
                <div
                  role="note"
                  style={{
                    marginTop: "8px",
                    padding: "8px 10px",
                    border: "1px solid color-mix(in srgb, var(--amber) 35%, var(--inner-border))",
                    borderRadius: "8px",
                    background: "color-mix(in srgb, var(--amber) 8%, var(--surface-2))",
                    color: "var(--text-secondary)",
                    fontSize: "11px",
                  }}
                >
                  <strong style={{ color: "var(--amber)" }}>
                    High CPU and memory spike while active.
                  </strong>{" "}
                  Use it only while debugging, then switch back to Metadata or Minimum.
                </div>
              ) : null}
              <p style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px" }}>
                Request-event metadata is always retained. Default drawer capture is metadata-only
                (Proxy→Provider method + allowlisted headers). Bodies stay opt-in, redacted, and
                deleted automatically after 15 minutes.
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
                      onSuccess: () => toast.success("IP display updated"),
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
