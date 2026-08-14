/**
 * wgcf wrapper — shells out to the bundled wgcf.exe binary to register Cloudflare
 * Warp accounts and generate WireGuard profiles.
 *
 * Flow:
 *   1. mkdir temp → wgcf register --accept-tos (creates wgcf-account.toml)
 *   2. wgcf generate -p wgcf-profile.conf (creates WireGuard profile)
 *   3. Parse profile .conf to extract PrivateKey, Address, PublicKey, Endpoint, DNS
 *   4. Parse account.toml to extract deviceId, accessToken, licenseKey, privateKey
 *   5. Return structured data for the service to persist.
 *
 * wgcf requires a working directory with write access (it writes account.toml
 * next to itself). We use a temp dir per registration.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Path to the bundled wgcf binary (.exe on Windows, bare on Linux). */
const WGCF_BIN = join(process.cwd(), "bin", `wgcf${process.platform === "win32" ? ".exe" : ""}`);

/** Parsed WireGuard profile from wgcf generate. */
export interface WgcfProfile {
  readonly privateKey: string;
  readonly addressV4: string;
  readonly addressV6: string;
  readonly publicKey: string;
  readonly endpoint: string;
  readonly endpointPort: number;
  readonly dns: string;
  readonly mtu: number;
}

/** Parsed Cloudflare account from wgcf register. */
export interface WgcfAccount {
  readonly deviceId: string;
  readonly accessToken: string;
  readonly licenseKey: string;
  readonly privateKey: string;
}

/** Combined registration result. */
export interface WgcfRegisterResult {
  readonly account: WgcfAccount;
  readonly profile: WgcfProfile;
}

/** Run a command and capture stdout/stderr. */
async function runCmd(cmd: string, args: readonly string[], cwd: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register a new Cloudflare Warp account and generate a WireGuard profile.
 * Returns all credentials needed to spawn a wireproxy instance.
 */
export async function registerWarpAccount(id: string): Promise<WgcfRegisterResult> {
  // Create a temp working directory for wgcf.
  const workDir = await mkdtemp(join(tmpdir(), `warp-${id}-`));

  try {
    // Step 1: Register account.
    const reg = await runCmd(WGCF_BIN, ["register", "--accept-tos"], workDir, 30000);
    if (reg.exitCode !== 0) {
      throw new Error(`wgcf register failed (exit ${reg.exitCode}): ${reg.stderr || reg.stdout}`);
    }

    // Parse account.toml — wgcf writes key=value lines.
    const accountText = await readFile(join(workDir, "wgcf-account.toml"), "utf8");
    const account = parseAccountToml(accountText);

    // Step 2: Generate WireGuard profile.
    const gen = await runCmd(WGCF_BIN, ["generate", "--profile", "wgcf-profile.conf"], workDir, 15000);
    if (gen.exitCode !== 0) {
      throw new Error(`wgcf generate failed (exit ${gen.exitCode}): ${gen.stderr || gen.stdout}`);
    }

    // Parse WireGuard profile .conf.
    const profileText = await readFile(join(workDir, "wgcf-profile.conf"), "utf8");
    const profile = parseWireGuardConf(profileText);

    return { account, profile };
  } finally {
    // Cleanup temp dir (best-effort).
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Import a Warp account from an existing WireGuard profile .conf file content.
 * This skips registration — the user already has the profile.
 */
export function parseImportedProfile(content: string, metadata?: { deviceId?: string; accessToken?: string; licenseKey?: string }): WgcfRegisterResult {
  const profile = parseWireGuardConf(content);
  return {
    account: {
      deviceId: metadata?.deviceId ?? "",
      accessToken: metadata?.accessToken ?? "",
      licenseKey: metadata?.licenseKey ?? "",
      privateKey: profile.privateKey,
    },
    profile,
  };
}

/** Parse wgcf-account.toml (simple key = "value" format). */
function parseAccountToml(text: string): WgcfAccount {
  const get = (key: string): string => {
    const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "im").exec(text);
    return match?.[1] ?? "";
  };
  return {
    deviceId: get("device_id"),
    accessToken: get("access_token"),
    licenseKey: get("license_key"),
    privateKey: get("private_key"),
  };
}

/** Parse a WireGuard .conf file (INI format with [Interface] + [Peer] sections). */
function parseWireGuardConf(text: string): WgcfProfile {
  const lines = text.split("\n");
  let section = "";
  let privateKey = "";
  let addressV4 = "";
  let addressV6 = "";
  let publicKey = "";
  let endpoint = "engage.cloudflareclient.com";
  let endpointPort = 2408;
  let dns = "1.1.1.1";
  let mtu = 1280;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).toLowerCase();
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const value = line.slice(eqIdx + 1).trim();

    if (section === "interface") {
      if (key === "privatekey") privateKey = value;
      if (key === "address") {
        // Address can be "v4/32, v6/128" — split and strip CIDR.
        const parts = value.split(",").map((s) => s.trim().split("/")[0]!.trim());
        addressV4 = parts.find((p) => p.includes(".") && !p.includes(":")) ?? "";
        addressV6 = parts.find((p) => p.includes(":")) ?? "";
      }
      if (key === "dns") dns = value.split(",")[0]!.trim();
      if (key === "mtu") mtu = Number(value) || 1280;
    }
    if (section === "peer") {
      if (key === "publickey") publicKey = value;
      if (key === "endpoint") {
        // "engage.cloudflareclient.com:2408" — split host:port
        const lastColon = value.lastIndexOf(":");
        if (lastColon > 0) {
          endpoint = value.slice(0, lastColon);
          endpointPort = Number(value.slice(lastColon + 1)) || 2408;
        } else {
          endpoint = value;
        }
      }
    }
  }

  if (!privateKey) throw new Error("WireGuard profile missing PrivateKey in [Interface]");
  if (!publicKey) throw new Error("WireGuard profile missing PublicKey in [Peer]");

  return { privateKey, addressV4, addressV6, publicKey, endpoint, endpointPort, dns, mtu };
}

/**
 * Generate a wireproxy .conf file from a Warp account.
 * This is what wireproxy reads to start a SOCKS5 proxy.
 */
export function generateWireProxyConf(account: {
  privateKey: string;
  addressV4: string;
  addressV6: string;
  publicKey: string;
  endpoint: string;
  endpointPort: number;
  dns: string;
  mtu: number;
  socksPort: number;
}): string {
  return [
    "[Interface]",
    `Address = ${account.addressV4}/32, ${account.addressV6}/128`,
    `PrivateKey = ${account.privateKey}`,
    `DNS = ${account.dns}`,
    `MTU = ${account.mtu}`,
    "",
    "[Peer]",
    `PublicKey = ${account.publicKey}`,
    `Endpoint = ${account.endpoint}:${account.endpointPort}`,
    "AllowedIPs = 0.0.0.0/0, ::/0",
    "",
    "[Socks5]",
    `BindAddress = 127.0.0.1:${account.socksPort}`,
    "",
  ].join("\n");
}
