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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#07111c] p-4">
      <div
        aria-hidden="true"
        data-login-backdrop
        className="absolute inset-0 bg-cover bg-center opacity-70"
        style={{ backgroundImage: `url(${LOGIN_BACKDROP_URL})` }}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(90deg,rgba(4,13,24,0.58),rgba(4,13,24,0.2)),linear-gradient(180deg,rgba(4,13,24,0.08),rgba(4,13,24,0.68))]" />
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: easeOut }}
        className="glass-2 relative w-full max-w-sm rounded-2xl border-white/25 bg-[rgba(8,20,33,0.26)] p-7 text-white shadow-[0_24px_90px_rgba(0,0,0,0.36)] backdrop-blur-xl"
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-2xl border border-white/25 bg-white/10 shadow-[0_10px_30px_rgba(0,0,0,0.24)]">
            <img src={LOGIN_LOGO_URL} alt="" className="h-full w-full object-cover" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">Cartethyia</h1>
            <p className="text-sm text-white/65">Internal Console</p>
          </div>
        </div>

        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Lock size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-3)]" />
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoFocus
            className="pr-10 pl-9"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
          <button
            type="button"
            aria-label={showPassword ? "Hide secret" : "Show secret"}
            onClick={() => setShowPassword((visible) => !visible)}
            className="absolute top-1/2 right-3 -translate-y-1/2 text-[var(--text-3)] transition-colors hover:text-white"
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {error && (
          <p className="mt-2.5 text-xs font-medium text-[var(--red)]">
            {error}
            {retryAfter !== null && ` (retry in ~${retryAfter}s)`}
          </p>
        )}

        <Button type="submit" disabled={busy || !password} className="mt-5 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <p className="mt-4 text-center text-[11px] text-white/55">
          <a
            href="https://x.com/RaaiVault/status/1934536437464281414?s=20"
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-white/75 underline decoration-white/30 underline-offset-2 hover:text-white"
          >
            Artwork source ↗
          </a>
          <br />
          <a href="/" className="mt-2 inline-block text-white/70 underline decoration-white/25 underline-offset-2 hover:text-white">
            ← Back to public page
          </a>
        </p>
      </motion.form>
    </div>
  );
}
