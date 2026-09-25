import { Loader2 } from "lucide-react";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "sonner";
import { DashboardShell } from "./components/Shell";
import ErrorBoundary from "./components/ErrorBoundary";
import { lazyWithRetry } from "./lib/lazy-retry";
import { consoleRequest, fetchSessionUser, setSessionTransitionListener } from "./lib/api";
import { queryClient } from "./lib/query-client";
import { queryKeys } from "./lib/query-keys";
import type { SessionUser } from "./lib/contracts";

/** Compact loading shell for lazy-route Suspense: never a blank viewport. */
function RouteLoadingShell(): ReactNode {
  return (
    <div
      role="status"
      aria-label="Loading console"
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        color: "var(--text-tertiary)",
      }}
    >
      <Loader2 size={22} className="animate-spin" aria-hidden="true" />
      <p style={{ fontSize: "12.5px" }}>Loading console…</p>
    </div>
  );
}

// Route chunks are content-hashed: after a rebuild the previous page's chunk
// URLs 404. lazyWithRetry reloads once to pick up the fresh index.html, then
// surfaces to the ErrorBoundary instead of looping.
const Login = lazyWithRetry(() => import("./routes/Login"), "login");
const Setup = lazyWithRetry(() => import("./routes/Setup"), "setup");
const Banned = lazyWithRetry(() => import("./routes/Banned"), "banned");
const Overview = lazyWithRetry(() => import("./routes/Overview"), "overview");
const Usage = lazyWithRetry(() => import("./routes/Usage"), "usage");
const ProviderDetail = lazyWithRetry(() => import("./routes/ProviderDetail"), "provider-detail");
const Providers = lazyWithRetry(() => import("./routes/Providers"), "providers");
const Combos = lazyWithRetry(() => import("./routes/Combos"), "combos");
const Quota = lazyWithRetry(() => import("./routes/Quota"), "quota");
const Proxy = lazyWithRetry(() => import("./routes/Proxy"), "proxy");
const Settings = lazyWithRetry(() => import("./routes/Settings"), "settings");
const CliTools = lazyWithRetry(() => import("./routes/CliTools"), "cli-tools");
const CliToolDetail = lazyWithRetry(() => import("./routes/CliToolDetail"), "cli-tool-detail");
const ConsoleLog = lazyWithRetry(() => import("./routes/ConsoleLog"), "console-log");
const Customization = lazyWithRetry(() => import("./routes/Customization"), "customization");
const Studio = lazyWithRetry(() => import("./routes/Studio"), "studio");

/**
 * Forwards shell-wide session transitions into router navigation. A 401 means
 * the session expired (go back to /login, preserving the return path); a 403
 * means the client is locked out (go to /banned). Registered once per router
 * lifetime; `api.ts` fans the signal out of every fresh failing response.
 */
function SessionTransitionBridge(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    setSessionTransitionListener((kind) => {
      // The session is unusable: drop every cached tenant view so the next
      // sign-in never renders the previous session's data.
      queryClient.clear();
      if (kind === "banned") {
        navigate("/banned", { replace: true });
        return;
      }
      navigate(`/login?returnTo=${encodeURIComponent(location.pathname)}`, { replace: true });
    });
    return () => setSessionTransitionListener(undefined);
  }, [navigate, location.pathname]);
  return null;
}

/** Wraps the top-level route tree so a lazy-route failure never blanks the viewport. */
function RouteErrorBoundary(): ReactNode {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={`${location.pathname}${location.search}`}>
      <Suspense fallback={<RouteLoadingShell />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/banned" element={<Banned />} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

function ProtectedRoutes(): ReactNode {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; user: SessionUser }
    | { kind: "unauthenticated"; needsSetup: boolean }
    | { kind: "blocked" }
  >({ kind: "loading" });
  const location = useLocation();
  const navigate = useNavigate();
  // Captured once: the session is fetched on mount only, never refetched
  // purely because the route changed.
  const [initialPath] = useState(() => location.pathname);
  useEffect(() => {
    const controller = new AbortController();
    // Prime the shared session cache so every downstream `useSessionUser()`
    // consumer reads from the same fetched result — a duplicate GET on route
    // mount would double-count login attempts against rate limits.
    void queryClient
      .fetchQuery({
        queryKey: queryKeys.session.current,
        queryFn: () => fetchSessionUser(),
        staleTime: 60_000,
      })
      .then((user) => {
        if (controller.signal.aborted) return;
        if (user) {
          queryClient.setQueryData(queryKeys.session.current, user);
          setState({ kind: "ready", user });
          if (user.isFirstBoot && initialPath !== "/setup")
            navigate("/setup", { replace: true });
          return;
        }
        // An unauthenticated result must never linger as fresh cache: a later
        // sign-in landing on a protected route would otherwise resolve this
        // stale `null` inside the 60s stale window and bounce straight back to
        // /login in a redirect loop.
        queryClient.removeQueries({ queryKey: queryKeys.session.current });
        void consoleRequest<{ requires_setup: boolean }>("/auth/first-boot", {
          signal: controller.signal,
        })
          .then((boot) => {
            if (controller.signal.aborted) return;
            setState({ kind: "unauthenticated", needsSetup: boot.requires_setup });
          })
          .catch(() => {
            if (!controller.signal.aborted)
              setState({ kind: "unauthenticated", needsSetup: false });
          });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 403
        ) {
          setState({ kind: "blocked" });
        } else {
          setState({ kind: "unauthenticated", needsSetup: false });
        }
      });
    return () => controller.abort();
  }, [initialPath, navigate]);
  if (state.kind === "loading") return null;
  if (state.kind === "blocked") return <Navigate to="/banned" replace />;
  if (state.kind === "unauthenticated")
    return (
      <Navigate
        to={
          state.needsSetup ? "/setup" : `/login?returnTo=${encodeURIComponent(location.pathname)}`
        }
        replace
      />
    );
  return (
    <DashboardShell user={state.user}>
      <ErrorBoundary resetKey={location.pathname}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/providers/:providerId" element={<ProviderDetail />} />
          <Route path="/combos" element={<Combos />} />
          <Route path="/quota" element={<Quota />} />
          <Route path="/proxy" element={<Proxy />} />
          <Route path="/customization" element={<Customization />} />
          <Route path="/model-lab" element={<Studio />} />
          <Route path="/cli-tools" element={<CliTools />} />
          <Route path="/cli-tools/:toolId" element={<CliToolDetail />} />
          <Route path="/console-log" element={<ConsoleLog />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </DashboardShell>
  );
}

export function App(): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/console">
        <SessionTransitionBridge />
        <RouteErrorBoundary />
        <Toaster
          position="top-right"
          offset={{ top: "6rem", right: "1rem" }}
          mobileOffset={{ top: "6rem", left: "1rem", right: "1rem" }}
          visibleToasts={2}
          richColors
          duration={5_000}
          toastOptions={{
            className: "toast-surface select-text",
            descriptionClassName: "select-text",
            classNames: {
              title: "select-text",
            },
            style: {
              background: "var(--glass-bg-2)",
              border: "1px solid var(--glass-border-2)",
              color: "var(--text-primary)",
              fontSize: "12.5px",
              userSelect: "text",
            },
            actionButtonStyle: {
              background: "var(--accent)",
              color: "var(--accent-foreground)",
            },
            cancelButtonStyle: {
              background: "var(--surface-muted)",
              color: "var(--text-primary)",
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export default App;
