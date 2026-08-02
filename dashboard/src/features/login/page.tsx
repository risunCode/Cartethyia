import { motion } from "framer-motion";
import { Eye, EyeOff, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, apiPost } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input, Label } from "../../components/ui/input";
import { easeOut } from "../../lib/motion";

const LOGIN_BACKDROP_URL = `${import.meta.env.BASE_URL}CartethyiaPi/kepitsusu.jpg`;
const LOGIN_LOGO_URL = `${import.meta.env.BASE_URL}cartethyia-sidebar.gif`;

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/login", { password });
      toast.success("Signed in");
      const next = params.get("next") || "/overview";
      navigate(next.startsWith("/") ? next : "/overview", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          const body = err.message;
          setRetryAfter(30);
          setError(body || "Too many attempts. Try again later.");
        } else {
          setError(err.message);
        }
      } else {
        setError("Unexpected error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f7f3ed] p-4 text-[var(--text-1)] dark:bg-[#08080b]">
      <div
        aria-hidden="true"
        data-login-backdrop
        className="absolute inset-0 bg-cover bg-center opacity-25 saturate-[0.85] dark:opacity-60 dark:saturate-100"
        style={{ backgroundImage: `url(${LOGIN_BACKDROP_URL})` }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(110deg,rgba(247,243,237,0.96),rgba(247,243,237,0.8)_52%,rgba(247,243,237,0.5))] dark:bg-[linear-gradient(110deg,rgba(4,13,24,0.78),rgba(4,13,24,0.3)_52%,rgba(4,13,24,0.62))]" />
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_18%_10%,rgba(217,119,87,0.16),transparent_32%),radial-gradient(circle_at_88%_88%,rgba(68,143,141,0.12),transparent_30%)] dark:bg-[radial-gradient(circle_at_18%_10%,rgba(217,119,87,0.2),transparent_32%),radial-gradient(circle_at_88%_88%,rgba(68,143,141,0.16),transparent_30%)]" />
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: easeOut }}
        className="glass-2 relative w-full max-w-[26rem] rounded-[28px] border-[var(--glass-border)] p-8 text-[var(--text-1)] shadow-[0_24px_80px_rgba(83,56,36,0.16)] dark:border-white/15 dark:shadow-[0_24px_90px_rgba(0,0,0,0.42)]"
      >
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-[22px] border border-black/10 bg-white/65 shadow-[0_12px_30px_rgba(83,56,36,0.14)] dark:border-white/20 dark:bg-white/10 dark:shadow-[0_10px_30px_rgba(0,0,0,0.24)]">
            <img src={LOGIN_LOGO_URL} alt="" width="64" height="64" className="h-full w-full object-cover" />
          </div>
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--accent)]">Private workspace</p>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--text-1)]">Cartethyia</h1>
            <p className="mt-1 text-sm text-[var(--text-2)]">Sign in to manage your gateway</p>
          </div>
        </div>

        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Lock size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-3)]" />
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            autoFocus
            className="h-11 bg-white/55 pr-10 pl-9 shadow-sm dark:bg-white/5"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password…"
          />
          <button
            type="button"
            aria-label={showPassword ? "Hide secret" : "Show secret"}
            onClick={() => setShowPassword((visible) => !visible)}
            className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1 text-[var(--text-3)] transition-colors hover:text-[var(--text-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          >
            {showPassword ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
          </button>
        </div>

        {error && (
          <p role="alert" aria-live="polite" className="mt-2.5 text-xs font-medium text-[var(--red)]">
            {error}
            {retryAfter !== null && ` (retry in ~${retryAfter}s)`}
          </p>
        )}

        <Button type="submit" disabled={busy || !password} className="mt-5 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-3)]">
          <a
            href="https://x.com/RaaiVault/status/1934536437464281414?s=20"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-[var(--inner-border)] underline-offset-2 transition-colors hover:text-[var(--text-1)]"
          >
            Artwork source ↗
          </a>
          <span aria-hidden="true">·</span>
          <a href="/" className="underline decoration-[var(--inner-border)] underline-offset-2 transition-colors hover:text-[var(--text-1)]">
            ← Back to public page
          </a>
        </div>
      </motion.form>
    </div>
  );
}
