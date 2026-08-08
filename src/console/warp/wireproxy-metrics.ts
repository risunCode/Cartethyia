/**
 * Wireproxy process metrics collector — reads per-instance RSS memory and
 * network bandwidth via OS-level tools.
 *
 * Linux: /proc/<pid>/status for RSS, /proc/<pid>/net/dev for network I/O.
 * Windows: `tasklist /fi "PID eq <pid>" /fo csv` for memory (VirtualMemorySize).
 * macOS: `ps -o rss= -p <pid>` for RSS.
 *
 * Network bandwidth is tracked as a delta between snapshots — we store the
 * raw cumulative bytes, and the summary computes the delta.
 */

import { readFileSync } from "node:fs";
import { platform } from "node:os";

const IS_LINUX: boolean = platform() === "linux";
const IS_WIN: boolean = platform() === "win32";

export interface ProcessMetrics {
  readonly rssKb: number;
  readonly rxBytes: number;
  readonly txBytes: number;
}

/** Previous network byte counts per pid, for delta calculation. */
const prevNetworkBytes = new Map<number, { rx: number; tx: number }>();

/**
 * Read process metrics for a given PID.
 * Returns zeros if the process is gone or the platform is unsupported.
 */
export async function readProcessMetrics(pid: number): Promise<ProcessMetrics> {
  if (pid <= 0) return { rssKb: 0, rxBytes: 0, txBytes: 0 };

  if (IS_LINUX) {
    return readLinuxMetrics(pid);
  }
  if (IS_WIN) {
    return readWindowsMetrics(pid);
  }
  // macOS or other — best effort with ps.
  return readPosixMetrics(pid);
}

function readLinuxMetrics(pid: number): ProcessMetrics {
  let rssKb = 0;
  let rxBytes = 0;
  let txBytes = 0;

  // RSS from /proc/<pid>/status — "VmRSS: 1234 kB"
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (match) rssKb = Number(match[1]) || 0;
  } catch {
    // Process gone — return zeros.
  }

  // Network bytes from /proc/<pid>/net/dev
  try {
    const netDev = readFileSync(`/proc/${pid}/net/dev`, "utf8");
    for (const line of netDev.split("\n").slice(2)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 17) continue;
      // Skip lo — only count external interfaces.
      const iface = parts[0]!.replace(":", "");
      if (iface === "lo") continue;
      rxBytes += Number(parts[1]) || 0;
      txBytes += Number(parts[9]) || 0;
    }
  } catch {
    // /proc/<pid>/net/dev may not exist for all processes.
  }

  return { rssKb, rxBytes, txBytes };
}

function readWindowsMetrics(pid: number): Promise<ProcessMetrics> {
  return (async (): Promise<ProcessMetrics> => {
    let rssKb = 0;
    try {
      const proc = Bun.spawn(["tasklist", "/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "ignore" });
      const output = await new Response(proc.stdout).text();
      await proc.exited.catch(() => {});
      // CSV: "wireproxy.exe","1234","Console","1","19,536 K"
      // The memory field is the last quoted field ending with "K".
      const lines = output.trim().split("\n");
      for (const line of lines) {
        const match = /"([\d,]+)\s+K"/.exec(line);
        if (match) { rssKb = Number(match[1]!.replace(/,/g, "")) || 0; break; }
      }
    } catch {
      // process gone
    }
    // Windows doesn't expose per-process network bytes via tasklist.
    // Network bandwidth per-instance requires ETW tracing (not available here).
    return { rssKb, rxBytes: 0, txBytes: 0 };
  })();
}

function readPosixMetrics(pid: number): Promise<ProcessMetrics> {
  return (async (): Promise<ProcessMetrics> => {
    let rssKb = 0;
    try {
      const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const output = (await new Response(proc.stdout).text()).trim();
      await proc.exited.catch(() => {});
      if (output) rssKb = Number(output) || 0;
    } catch {
      // process gone
    }
    return { rssKb, rxBytes: 0, txBytes: 0 };
  })();
}

/**
 * Compute bandwidth delta for a pid since the last snapshot.
 * Returns { rxDelta, txDelta } in bytes.
 */
export function bandwidthDelta(pid: number, currentRx: number, currentTx: number): { rxDelta: number; txDelta: number } {
  const prev = prevNetworkBytes.get(pid);
  let rxDelta = 0;
  let txDelta = 0;
  if (prev) {
    rxDelta = Math.max(0, currentRx - prev.rx);
    txDelta = Math.max(0, currentTx - prev.tx);
  }
  prevNetworkBytes.set(pid, { rx: currentRx, tx: currentTx });
  return { rxDelta, txDelta };
}

/**
 * Clear tracked state for a pid (call when a process is stopped).
 */
export function clearProcessMetrics(pid: number): void {
  prevNetworkBytes.delete(pid);
}
