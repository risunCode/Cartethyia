import { UserPlus } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { consoleRequest } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { queryKeys } from "../lib/query-keys";

interface SetupResult {
  readonly status: "success" | "failed";
  readonly message?: string;
}

export default function Setup(): ReactNode {
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim()) {
      setError("Administrator username is required.");
      return;
    }
    if (password.length < 8) {
      setError("Administrator password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await consoleRequest<SetupResult>("/auth/setup", {
        method: "POST",
        body: JSON.stringify({
          username: username.trim(),
          password,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        }),
      });
      if (result.status !== "success") {
        setError(result.message ?? "Setup failed. Please try again.");
        return;
      }
      // Clear any cached session state so a previously primed unauthenticated
      // `null` cannot steer the next sign-in back into a redirect loop.
      queryClient.removeQueries({ queryKey: queryKeys.session.current });
      navigate("/login", { replace: true });
    } catch (reason: unknown) {
      if (reason && typeof reason === "object" && "message" in reason) {
        const msg = (reason as { message: unknown }).message;
        if (typeof msg === "string") {
          setError(msg);
          return;
        }
      }
      setError("An unexpected network error occurred.");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="auth-viewport">
      <div className="card-solid auth-window">
        <div className="auth-header">
          <div className="auth-logo" aria-hidden="true">
            C
          </div>
          <h1 className="auth-title">Cartethyia Console Setup</h1>
          <p className="auth-desc">Configure the administrator account for Cartethyia AI Gateway</p>
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <Input
            label="Administrator Username"
            id="setup-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            placeholder="e.g. admin, risun"
          />

          <Input
            label="Display Name"
            hint="(optional)"
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            autoComplete="name"
            placeholder="e.g. Administrator, risun"
          />

          <Input
            label="Master Password"
            hint="(min. 8 chars)"
            id="setup-password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />

          <Input
            label="Confirm Password"
            id="setup-confirm"
            type="password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />

          {error ? (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "10px",
                background: "var(--red-soft)",
                color: "var(--red)",
                fontSize: "12.5px",
                fontWeight: 500,
              }}
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <Button
            variant="primary"
            type="submit"
            disabled={pending}
            style={{ width: "100%", marginTop: "6px", height: "40px" }}
            icon={<UserPlus size={15} />}
          >
            {pending ? "Initializing…" : "Complete Setup"}
          </Button>
        </form>
      </div>
    </main>
  );
}
