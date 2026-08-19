import { Eye, EyeOff, Lock, TriangleAlert } from "lucide-solid";
import { createSignal, onMount, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";

import { ApiError } from "@lib/api";
import { ConsoleContractError, consolePost } from "@lib/console-api";
import { safeConsoleNextPath } from "@/routes";

const LOGIN_BACKDROP_URL = `${import.meta.env.BASE_URL}cartethyia-2.webp`;

export function LoginPage() {
  let passwordInputRef: HTMLInputElement | undefined;
  const [password, setPassword] = createSignal("");
  const [showPassword, setShowPassword] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();

  onMount(() => {
    // Focus immediately and ensure focus stays even after async route transition
    requestAnimationFrame(() => {
      passwordInputRef?.focus();
      passwordInputRef?.select();
    });
  });

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (busy() || !password()) return;
    setBusy(true);
    setError(null);
    try {
      await consolePost("/auth/login", { username: "admin", password: password(), remember: true });
      const nextParam = params.next;
      const next = safeConsoleNextPath(typeof nextParam === "string" ? nextParam : undefined);
      navigate(next, { replace: true });
    } catch (caught: unknown) {
      if (caught instanceof ApiError || caught instanceof ConsoleContractError) {
        setError(caught.status === 429 ? (caught.message || "Too many attempts. Try again later.") : caught.message);
      } else {
        setError("Unexpected error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--page-bg)] p-4 text-[var(--text-primary)]">
      <div aria-hidden="true" data-login-backdrop class="absolute inset-0 bg-cover opacity-55 saturate-[1.05] dark:opacity-80 dark:saturate-100" style={{ "background-image": `url(${LOGIN_BACKDROP_URL})`, "background-position": "center 6%" }} />
      <div aria-hidden="true" class="absolute inset-0 bg-[linear-gradient(110deg,rgba(247,243,237,0.22),rgba(247,243,237,0.06)_50%,rgba(247,243,237,0.04))] dark:bg-[linear-gradient(110deg,rgba(4,13,24,0.24),rgba(4,13,24,0.06)_50%,rgba(4,13,24,0.12))]" />
      <div aria-hidden="true" class="absolute inset-0 bg-[radial-gradient(circle_at_18%_10%,rgba(217,119,87,0.04),transparent_30%),radial-gradient(circle_at_88%_88%,rgba(68,143,141,0.04),transparent_28%)] dark:bg-[radial-gradient(circle_at_18%_10%,rgba(217,119,87,0.06),transparent_30%),radial-gradient(circle_at_88%_88%,rgba(68,143,141,0.05),transparent_28%)]" />
      <form onSubmit={submit} class="login-enter login-card relative w-full max-w-[23.5rem] rounded-[var(--radius-xl)] border-[var(--glass-border)] p-6 text-[var(--text-primary)] shadow-[0_24px_80px_rgba(0,0,0,0.28)] sm:p-7 dark:border-white/20 dark:shadow-[0_24px_90px_rgba(0,0,0,0.55)]">
        <div class="mb-6 flex flex-col items-center text-center">
          <div>
            <h1 class="login-card-title text-2xl font-bold tracking-tight">Cartethyia</h1>
            <p class="login-card-subtitle mt-1.5 text-sm font-medium text-white/90">Sign in to manage your gateway</p>
          </div>
        </div>

        <label for="password" class="login-card-label mb-1.5 block text-xs font-semibold">Password</label>
        <div class="relative">
          <Lock size={15} aria-hidden="true" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-white/70 drop-shadow" />
          <input ref={passwordInputRef} id="password" name="password" type={showPassword() ? "text" : "password"} autocomplete="current-password" autofocus class="h-11 w-full rounded-[var(--radius-control)] border border-white/25 bg-black/40 pr-10 pl-9 text-sm text-white placeholder:text-white/60 shadow-sm outline-none focus:border-[var(--accent)]" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} placeholder="Enter your password…" />
          <button type="button" aria-label={showPassword() ? "Hide secret" : "Show secret"} onClick={() => setShowPassword((visible) => !visible)} class="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1 text-white/75 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]">
            {showPassword() ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
          </button>
        </div>

        <Show when={error()} keyed>
          {(message) => (
            <p role="alert" aria-live="assertive" class="login-flash mt-4 flex items-start gap-2.5 rounded-[var(--radius-control)] border border-red-500/50 bg-red-950/80 px-3.5 py-2.5 text-xs font-semibold text-red-100 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-md">
              <TriangleAlert size={15} aria-hidden="true" class="mt-0.5 shrink-0 text-red-400" />
              <span class="leading-relaxed drop-shadow">{message}</span>
            </p>
          )}
        </Show>

        <button type="submit" disabled={busy() || !password()} class="mt-5 h-11 w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
          {busy() ? "Signing in…" : "Sign in"}
        </button>

        <div class="login-card-note mt-5 text-center text-[12px] font-medium text-white/85">
          <p>Password is set via <code class="rounded bg-black/50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-white">CONSOLE_PASSWORD</code> in <code class="rounded bg-black/50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-white">.env</code></p>
        </div>
      </form>
    </div>
  );
}

export default LoginPage;
