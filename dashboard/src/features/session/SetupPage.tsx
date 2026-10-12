import { UserPlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DataTable } from "../../components/ui/layout";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { consoleRequest } from "../../data/api";
import { readBackupFile } from "../../lib/backup-file";
import { queryClient } from "../../data/query-client";
import { queryKeys } from "../../data/query-keys";

interface SetupResult {
  readonly status: "success" | "failed";
  readonly message?: string;
}

/** One part of the file that the current schema cannot restore. */
interface RestoreWarning {
  readonly table?: string;
  readonly column?: string;
  readonly reason: string;
}

interface SetupInspectResult extends SetupResult {
  readonly version?: number;
  readonly exportedAt?: string;
  readonly rows?: readonly {
    readonly section: string;
    readonly table: string;
    readonly count: number;
    readonly supported: boolean;
  }[];
  readonly total?: number;
  readonly warnings?: readonly RestoreWarning[];
}

interface SetupRestoreResult extends SetupResult {
  readonly restored?: Record<string, number>;
  readonly warnings?: readonly RestoreWarning[];
}

/**
 * What a backup holds, as the server described it.
 *
 * "Supported" comes from the live schema, not from a table list kept in the
 * browser — a mirror like that drifts the moment a migration lands, and then
 * the wizard would be confidently wrong about what it can restore.
 */
interface BackupPreview {
  readonly fileName: string;
  readonly version: number;
  readonly exportedAt: string;
  readonly rows: readonly {
    readonly section: string;
    readonly table: string;
    readonly count: number;
    readonly supported: boolean;
  }[];
  readonly total: number;
  readonly warnings: readonly RestoreWarning[];
}

export default function Setup(): ReactNode {
  const navigate = useNavigate();
  /**
   * Whether this console can still take a first account. `null` while the
   * answer is in flight — the form stays disabled until it is known, so a
   * console that already has an account cannot be raced into a second one.
   */
  const [open, setOpen] = useState<boolean | null>(null);
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void consoleRequest<{ requires_setup: boolean }>("/auth/first-boot")
      .then((result) => {
        if (!active) return;
        setOpen(result.requires_setup);
        if (!result.requires_setup) navigate("/login", { replace: true });
      })
      .catch(() => {
        // A failed check must not disable the wizard outright — the submit
        // itself reports the real reason — but the form stays disabled until
        // an answer arrives so nothing is submitted blind.
        if (active) setOpen(true);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (open === false) {
      setError("This console already has an account. Sign in instead.");
      return;
    }
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

  const restore = async (file: File) => {
    setPending(true);
    setError(null);
    try {
      // A backup carries no sign-in accounts, so the administrator is always
      // part of the restore request rather than a second pass over the file.
      if (password.length < 8) {
        setError("Administrator password must be at least 8 characters.");
        return;
      }
      if (password !== confirm) {
        setError("Passwords do not match.");
        return;
      }
      const backup = await readBackupFile(file);
      const result = await consoleRequest<SetupRestoreResult>("/auth/setup/restore", {
        method: "POST",
        body: JSON.stringify({
          backup,
          username: username.trim(),
          password,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        }),
      });
      if (result.status !== "success") {
        setError(result.message ?? "Restore failed. Please try again.");
        return;
      }
      queryClient.removeQueries({ queryKey: queryKeys.session.current });
      navigate("/login", { replace: true });
    } catch (reason: unknown) {
      if (reason instanceof Error) {
        setError(reason.message);
        return;
      }
      setError("An unexpected network error occurred.");
    } finally {
      setPending(false);
    }
  };

  const pickFile = (file: File | null) => {
    setRestoreFile(file);
    setError(null);
    if (file === null) {
      setPreview(null);
      return;
    }
    // Inspect on the server: only the live schema knows which of these tables
    // still exist, so the "unsupported" verdict cannot be computed here.
    void readBackupFile(file)
      .then(async (parsed) => {
        try {
          const result = await consoleRequest<SetupInspectResult>("/auth/setup/inspect", {
            method: "POST",
            body: JSON.stringify({ backup: parsed }),
          });
          if (result.status !== "success") {
            setPreview(null);
            setError(result.message ?? "Could not read that backup.");
            return;
          }
          setPreview({
            fileName: file.name,
            version: result.version ?? 0,
            exportedAt: result.exportedAt ?? "",
            rows: result.rows ?? [],
            total: result.total ?? 0,
            warnings: result.warnings ?? [],
          });
        } catch {
          // A failed peek must not block the restore: the button stays live and
          // the real attempt reports the real reason.
          setPreview(null);
        }
      })
      .catch((reason: unknown) => {
        setPreview(null);
        setError(reason instanceof Error ? reason.message : "That file is not a JSON backup.");
      });
  };

  if (open === false) {
    return (
      <main className="auth-viewport">
        <div className="card-solid auth-window">
          <div className="auth-header">
            <div className="auth-logo" aria-hidden="true" />
            <h1 className="auth-title">Account Already Registered</h1>
            <p className="auth-desc">
              This console already has an administrator account, so setup is closed.
              Sign in with the account that was created.
            </p>
          </div>
          <div className="flex flex-col gap-7">
            <SetupError message="Setup is already finished. Creating a second administrator is not possible from here." />
            <Link to="/login" className="no-underline">
              <Button variant="primary" type="button" className="w-full h-20">
                Go to sign in
              </Button>
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-viewport">
      <div className="card-solid auth-window">
        <div className="auth-header">
          <div className="auth-logo" aria-hidden="true" />
          <h1 className="auth-title">Cartethyia Console Setup</h1>
          <p className="auth-desc">
            {mode === "create"
              ? "Configure the administrator account for Cartethyia AI Gateway"
              : "Restore a backup's configuration. A backup carries no accounts, so set the administrator for this install."}
          </p>
        </div>

        <div className="flex gap-4 mb-7">
          <Button type="button" variant={mode === "create" ? "primary" : "secondary"} onClick={() => setMode("create")}>
            New account
          </Button>
          <Button type="button" variant={mode === "restore" ? "primary" : "secondary"} onClick={() => setMode("restore")}>
            Restore backup
          </Button>
        </div>

        {mode === "restore" ? (
          <div className="flex flex-col gap-7">
            <div className="flex items-center gap-2 min-h-10">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => restoreInputRef.current?.click()}
                disabled={pending || open === null}
              >
                Choose file…
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={pending || open === null || restoreFile === null}
                onClick={() => {
                  if (!restoreFile) return;
                  void restore(restoreFile);
                }}
              >
                {pending ? "Restoring…" : "Restore backup"}
              </Button>
            </div>
            <input
              ref={restoreInputRef}
              id="setup-backup"
              type="file"
              accept="application/json,.json,.gz,application/gzip"
              disabled={pending}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                pickFile(file);
                event.target.value = "";
              }}
            />

            {preview ? <BackupSummary preview={preview} /> : null}

            <div className="flex flex-col gap-3">
              <p className="m-0 text-text-secondary text-caption">
                A backup holds no sign-in accounts, so restoring one never
                restores an administrator. Set the account for this install —
                the file's own passwords are not reused.
              </p>
              <Input
                label="Administrator Username"
                id="restore-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
              <Input
                label="Master Password"
                hint="(min. 8 chars)"
                id="restore-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <Input
                label="Confirm Password"
                id="restore-confirm"
                type="password"
                required
                minLength={8}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </div>

            {error ? <SetupError message={error} /> : null}
          </div>
        ) : (
        <form onSubmit={submit} className="flex flex-col gap-7">
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

          {error ? <SetupError message={error} /> : null}

          <Button
            variant="primary"
            type="submit"
            disabled={pending || open === null}
            className="w-full mt-3 h-20"
            icon={<UserPlus size={15} />}
          >
            {pending ? "Initializing…" : "Complete Setup"}
          </Button>
        </form>
        )}
      </div>
    </main>
  );
}

/**
 * What is inside the chosen backup.
 *
 * Tables the current build does not have are listed with a badge instead of
 * being hidden: a backup from an older version still restores everything that
 * does match, and the operator is entitled to see what will not.
 */
function BackupSummary({ preview }: { readonly preview: BackupPreview }): ReactNode {
  const unsupported = preview.rows.filter((row) => !row.supported);
  const supported = preview.rows.filter((row) => row.supported);
  const exported = preview.exportedAt ? preview.exportedAt.replace("T", " ").slice(0, 19) : "unknown";

  return (
    <div className="flex flex-col gap-2 p-3 border border-inner-border rounded-control bg-surface-2">
      <div className="flex items-center flex-wrap gap-1.5">
        <span className="min-w-0 overflow-hidden whitespace-nowrap text-ellipsis text-body font-semibold" title={preview.fileName}>
          {preview.fileName}
        </span>
        <span className="inline-flex items-center flex-none px-3.5 py-px border border-inner-border rounded-md bg-surface-2 text-text-secondary text-badge tabular-nums">v{preview.version}</span>
        {unsupported.length > 0 ? (
          <span className="inline-flex items-center flex-none px-3.5 py-px border rounded-md bg-surface-2 text-badge tabular-nums border-warning-line text-status-warning">
            {unsupported.length} unsupported
          </span>
        ) : null}
      </div>
      <p className="m-0 text-text-secondary text-caption">
        {preview.total} rows across {preview.rows.length} tables · exported {exported}
      </p>
      {unsupported.length > 0 ? (
        <p className="m-0 text-caption text-status-warning">
          {unsupported.length === preview.rows.length
            ? "None of these tables exist in this build, so nothing can be restored."
            : "This build no longer has some of these tables. The rest still restores."}
        </p>
      ) : null}
      {preview.rows.length === 0 ? (
        <p className="m-0 text-text-secondary text-caption">This backup is empty.</p>
      ) : (
        <div className="max-h-110 overflow-auto">
          <DataTable headers={["Table", "Section", "Rows"]} dense>
            {[...supported, ...unsupported].map((row) => (
              <tr key={`${row.section}/${row.table}`}>
                <td>{row.table}</td>
                <td>{row.section}</td>
                <td className="text-right">
                  {row.supported ? (
                    row.count
                  ) : (
                    <span className="inline-flex items-center flex-none px-3.5 py-px border rounded-md bg-surface-2 text-badge tabular-nums border-warning-line text-status-warning">unsupported</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}
    </div>
  );
}

function SetupError({ message }: { readonly message: string }): ReactNode {
  return (
    <div
      className="py-5 px-7 rounded-control bg-red-soft text-red text-caption font-medium"
      role="alert"
    >
      {message}
    </div>
  );
}
