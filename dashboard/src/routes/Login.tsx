import { LogIn } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { consoleRequest } from "../lib/api";
import { queryClient } from "../lib/query-client";
import { queryKeys } from "../lib/query-keys";

interface LoginResult {
  readonly status: "success" | "failed";
  readonly message?: string;
  readonly requires_setup?: boolean;
}

function safeReturnPath(value: string | null): string {
  if (value?.startsWith("/") && !value.startsWith("//")) return value;
  return "/";
}

export default function Login(): ReactNode {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);

  useEffect(() => {
    let active = true;
    void consoleRequest<{ requires_setup: boolean }>("/auth/first-boot")
      .then((result) => {
        if (!active) return;
        if (result.requires_setup) {
          navigate("/setup", { replace: true });
          return;
        }
        setCheckingSetup(false);
      })
      .catch(() => {
        if (active) setCheckingSetup(false);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await consoleRequest<LoginResult>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (result.status !== "success") {
        if (result.requires_setup) {
          navigate("/setup", { replace: true });
          return;
        }
        setError(result.message ?? "Authentication failed. Please check your credentials.");
        return;
      }
      // Drop any cached session state (including a stale unauthenticated
      // `null`) so the protected-route guard refetches the now-authenticated
      // session instead of replaying the null and bouncing back to /login.
      queryClient.removeQueries({ queryKey: queryKeys.session.current });
      navigate(result.requires_setup ? "/setup" : safeReturnPath(params.get("returnTo")), {
        replace: true,
      });
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

  if (checkingSetup) {
    return (
      <main className="auth-viewport">
        <div className="card-solid auth-window">
          <div className="auth-header">
            <div className="auth-logo" aria-hidden="true">
              C
            </div>
            <h1 className="auth-title">Cartethyia Console</h1>
            <p className="auth-desc">Checking console setup...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-viewport">
      <div className="card-solid auth-window">
        <div className="auth-header">
          <div className="auth-logo" aria-hidden="true">
            C
          </div>
          <h1 className="auth-title">Cartethyia Console</h1>
          <p className="auth-desc">Sign in to manage AI Gateway routing and providers</p>
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <Input
            label="Username"
            id="login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            placeholder="admin"
          />

          <Input
            label="Password"
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
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
            icon={<LogIn size={15} />}
          >
            {pending ? "Authenticating…" : "Sign In"}
          </Button>
        </form>
      </div>
    </main>
  );
}
