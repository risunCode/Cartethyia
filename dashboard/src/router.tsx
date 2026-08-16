import { Match, Switch, createResource, lazy, type JSX } from "solid-js";
import { Navigate, Route, Router, useLocation, useNavigate } from "@solidjs/router";

import { consoleGet, consolePost } from "./lib/console-api";
import { setUnauthorizedHandler } from "./lib/api";
import { Sidebar } from "./components/layout/Sidebar";
import { Header } from "./components/layout/Header";
import { Footer } from "./components/layout/Footer";
import type { FooterStatus } from "./components/layout/Footer";

// Lazy load pages for code splitting.
const Overview = lazy(() => import("@pages/Overview"));
const Usage = lazy(() => import("@pages/Usage"));
const Providers = lazy(() => import("@pages/Providers"));
const Quota = lazy(() => import("@pages/Quota"));
const ConsoleLog = lazy(() => import("@pages/ConsoleLog"));
const Settings = lazy(() => import("@pages/Settings"));
const Share = lazy(() => import("@pages/Share"));
const LoginPage = lazy(() => import("./features/login/page").then((m) => ({ default: m.LoginPage })));
const LandingPage = lazy(() => import("./landing/page").then((m) => ({ default: m.LandingPage })));

/**
 * Persistent app chrome (sidebar, header, footer) around every authenticated
 * route. The daemon `/dashboard` summary backs the footer's status/version;
 * a failed fetch degrades to "unknown" rather than blocking the shell.
 */
export function DashboardShell(props: { children: JSX.Element }): JSX.Element {
  const navigate = useNavigate();
  const [health] = createResource(async (): Promise<{ status: FooterStatus; version?: string }> => {
    try {
      const summary = await consoleGet<{ version?: string }>("/dashboard");
      return { status: "active", version: summary.version };
    } catch {
      return { status: "unknown" };
    }
  });

  const signOut = async (): Promise<void> => {
    await consolePost("/auth/logout").catch(() => undefined);
    navigate("/login", { replace: true });
  };

  return (
    <div class="flex min-h-screen bg-[var(--page-bg)]">
      <Sidebar />
      <div class="flex min-w-0 flex-1 flex-col">
        <Header onSignOut={() => void signOut()} />
        <main class="min-w-0 flex-1 px-4 py-4 lg:px-6 lg:py-6">{props.children}</main>
        <Footer status={health()?.status ?? "unknown"} version={health()?.version} />
      </div>
    </div>
  );
}

/**
 * Blocks protected routes until the daemon session is confirmed. A failed or
 * unauthenticated session check redirects to the login page; expired sessions
 * mid-flight are caught by the global 401 handler registered in `App`.
 */
function AuthGuard(props: { children: JSX.Element }): JSX.Element {
  const location = useLocation();
  const [session] = createResource(async (): Promise<boolean> => {
    try {
      await consoleGet("/auth/session");
      return true;
    } catch {
      return false;
    }
  });

  return (
    <Switch>
      <Match when={session.state === "pending"}>
        <div class="flex h-screen items-center justify-center text-sm text-[var(--text-3)]">
          Checking session…
        </div>
      </Match>
      <Match when={session.state === "ready" && session()}>
        <DashboardShell>{props.children}</DashboardShell>
      </Match>
      <Match when={true}>
        <Navigate href={`/login?next=${encodeURIComponent(location.pathname)}`} />
      </Match>
    </Switch>
  );
}

/**
 * Catch-all for unmatched paths (e.g. `/share` without a token id). The
 * `/console` console-log page used to live here; that path now collides with
 * the daemon's `/console/*` API prefix on every proxy, so the page moved to
 * `/logs`.
 */
function NotFound(): JSX.Element {
  return (
    <main class="flex min-h-screen flex-col items-center justify-center gap-2 px-6 text-center">
      <p class="text-xs uppercase tracking-[0.3em] text-[var(--text-3)]">404</p>
      <h1 class="text-2xl font-semibold">Page not found</h1>
      <a class="underline" href="/">Return to the landing page</a>
    </main>
  );
}

function App(): JSX.Element {
  // Any 401 from the console API plane (expired or revoked session) lands the
  // operator back on the login screen.
  setUnauthorizedHandler(() => {
    window.location.assign("/login");
  });

  return (
    <Router>
      {/* Public marketing home; unauthenticated by contract. */}
      <Route path="/" component={LandingPage} />
      <Route path="/login" component={LoginPage} />
      {/* Share pages are credential-free by contract and stay public. */}
      <Route path="/share/:shareId" component={Share} />
      <Route path="/overview" component={() => <AuthGuard><Overview /></AuthGuard>} />
      <Route path="/usage" component={() => <AuthGuard><Usage /></AuthGuard>} />
      <Route path="/providers" component={() => <AuthGuard><Providers /></AuthGuard>} />
      <Route path="/quota" component={() => <AuthGuard><Quota /></AuthGuard>} />
      <Route path="/logs" component={() => <AuthGuard><ConsoleLog /></AuthGuard>} />
      <Route path="/settings" component={() => <AuthGuard><Settings /></AuthGuard>} />
      {/* Unknown paths must never render a blank document. */}
      <Route path="*" component={NotFound} />
    </Router>
  );
}

export default App;
