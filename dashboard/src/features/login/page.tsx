import { motion } from "framer-motion";
import { Boxes, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, apiPost } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Input, Label } from "../../components/ui/input";
import { easeOut } from "../../lib/motion";

export function LoginPage() {
  const [password, setPassword] = useState("");
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
    <div className="flex min-h-screen items-center justify-center p-4">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: easeOut }}
        className="glass-2 w-full max-w-sm rounded-2xl p-7"
      >
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-[#0a84ff] to-[#5e5ce6] text-white shadow-[0_10px_30px_rgba(10,132,255,0.4)]">
            <Boxes size={28} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Cartethyia</h1>
            <p className="text-sm text-[var(--text-2)]">Internal Console</p>
          </div>
        </div>

        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Lock size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-3)]" />
          <Input
            id="password"
            type="password"
            autoFocus
            className="pl-9"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
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

        <p className="mt-4 text-center text-[11px] text-[var(--text-3)]">
          Single admin · JWT session · rate-limited
        </p>
      </motion.form>
    </div>
  );
}
