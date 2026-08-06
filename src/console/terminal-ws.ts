/**
 * Terminal WebSocket backend — executes shell commands as root.
 *
 * Security:
 * - Only authenticated console sessions can upgrade (checked in main.ts before upgrade)
 * - Commands run via Bun.spawn with a timeout
 * - Output is captured (stdout + stderr) and sent back as text
 * - Interactive TUI apps (btop, htop, vim, etc.) are detected and rejected
 *   with a helpful message — they need a PTY, not a pipe
 * - Catastrophic patterns (rm -rf /, fork bombs) are blocked as a safety net;
 *   everything else runs with full root access
 */

import type { ServerWebSocket } from "bun";

interface TerminalSession {
  ws: ServerWebSocket<TerminalSession>;
}

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Commands that need a PTY — reject with guidance. */
const TUI_COMMANDS: Record<string, true> = {
  btop: true, htop: true, top: true, vim: true, vi: true, nano: true, emacs: true,
  less: true, more: true, man: true, tmux: true, screen: true, tig: true, lazygit: true,
};

/** Catastrophic patterns that are always blocked as a safety net. */
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\b:\(\)\s*\{.*;\s*:\}/,  // fork bomb: :(){ :|:& };:
];

interface TerminalMessage {
  type: "command" | "ping";
  data?: string;
}

interface TerminalResponse {
  type: "output" | "error" | "exit" | "connected" | "pong";
  data?: string;
  exitCode?: number;
}

function send(ws: ServerWebSocket<TerminalSession>, msg: TerminalResponse): void {
  ws.send(JSON.stringify(msg));
}

async function executeCommand(ws: ServerWebSocket<TerminalSession>, cmd: string): Promise<void> {
  const trimmed = cmd.trim();
  if (!trimmed) return;

  // Parse the base command (first token)
  const parts = trimmed.split(/\s+/);
  const base = parts[0]?.toLowerCase() ?? "";

  // Block dangerous patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      send(ws, { type: "error", data: `Blocked: command matches a dangerous pattern.` });
      return;
    }
  }

  // Handle builtins
  if (base === "clear" || base === "cls") {
    send(ws, { type: "output", data: "__CLEAR__" });
    return;
  }
  if (base === "help") {
    send(ws, {
      type: "output",
      data: [
        "Cartethyia Terminal — root shell via WebSocket",
        "",
        "  Any command runs with full root access.",
        "  fastfetch       System info display",
        "  speedtest-cli   Internet bandwidth test",
        "  curl <url>      HTTP client",
        "  sqlite3 <db>    SQLite database CLI",
        "  ps / top -bn1   Process listing (one-shot)",
        "  ls / cat / echo Standard Unix tools",
        "  df -h / free -h Disk & memory usage",
        "  clear           Clear terminal",
        "  help            Show this help",
        "",
        "Note: Interactive TUI apps (btop, htop, vim) need a PTY — not supported here.",
        "      Use 'top -bn1' or 'ps aux' for one-shot snapshots instead.",
      ].join("\n"),
    });
    return;
  }

  // Reject TUI commands
  if (TUI_COMMANDS[base] === true) {
    send(ws, {
      type: "output",
      data: `${base} requires an interactive TTY. Use 'ps' or 'top -bn1' for a one-shot snapshot instead.`,
    });
    return;
  }

  try {
    const proc = Bun.spawn({
      cmd: ["sh", "-c", trimmed],
      stdout: "pipe",
      stderr: "pipe",
      stdin: null,
      timeout: COMMAND_TIMEOUT_MS,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    let output = stdout;
    if (stderr.length > 0) {
      output = output.length > 0 ? `${output}\n${stderr}` : stderr;
    }

    // Truncate if too large
    if (output.length > MAX_OUTPUT_BYTES) {
      output = `${output.slice(0, MAX_OUTPUT_BYTES)}\n... (output truncated at ${MAX_OUTPUT_BYTES} bytes)`;
    }

    const exitCode = await proc.exited;
    send(ws, { type: "output", data: output || "(no output)" });
    send(ws, { type: "exit", exitCode });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      send(ws, { type: "error", data: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.` });
    } else {
      send(ws, { type: "error", data: `Failed to execute: ${error instanceof Error ? error.message : "unknown error"}` });
    }
  }
}

/** WebSocket handler for Bun.serve — terminal command execution. */
export const terminalWebSocket = {
  open(ws: ServerWebSocket<TerminalSession>) {
    send(ws, { type: "connected", data: "Cartethyia Terminal — type 'help' for available commands." });
  },

  async message(ws: ServerWebSocket<TerminalSession>, message: string | Buffer) {
    try {
      const msg = JSON.parse(typeof message === "string" ? message : message.toString()) as TerminalMessage;
      if (msg.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }
      if (msg.type === "command" && typeof msg.data === "string") {
        await executeCommand(ws, msg.data);
      }
    } catch {
      send(ws, { type: "error", data: "Invalid message format." });
    }
  },

  close(ws: ServerWebSocket<TerminalSession>) {
    // Session cleanup — nothing extra needed since we don't keep long-lived state
  },

  drain(ws: ServerWebSocket<TerminalSession>) {
    // Backpressure relief — no action needed for our fire-and-forget model
  },
} as const;

/** WebSocket data type for Bun.serve. */
export type TerminalWsData = TerminalSession;

/**
 * Checks whether a request is eligible for terminal WS upgrade.
 * The actual auth check happens in main.ts before calling server.upgrade().
 */
export function isTerminalUpgradeRequest(request: Request): boolean {
  return request.headers.get("upgrade") === "websocket" &&
    new URL(request.url).pathname === "/console/api/terminal/ws";
}
