/**
 * The client platform this gateway presents to upstreams.
 *
 * A gateway is not the machine the CLI runs on: it forwards on behalf of a
 * client, and whichever OS it happens to be deployed on says nothing about
 * who is calling. Stamping the host's real platform would make every
 * upstream see a Linux datacenter box — wrong about the caller, and a
 * fingerprint no real CLI traffic looks like.
 *
 * So the platform is fixed: macOS, the one the reference CLIs' own traffic is
 * dominated by. It is fixed rather than configurable because the point is
 * agreement — one deployment claiming four operating systems is the
 * inconsistency worth avoiding, and a per-deployment override is how that
 * disagreement comes back.
 *
 * Every value below is what the real client would report, taken from each
 * client's own source rather than guessed.
 */

/**
 * `os_info` — the crate Codex reads this from — returns the marketing name
 * (`Mac OS`) separately from the kernel-level version, so the two are kept
 * apart here rather than fused into one string.
 */
const MACOS_NAME = "Mac OS";
const MACOS_VERSION = "27.0.1";

/**
 * Terminal token appended to a Codex user agent.
 *
 * Codex reads the real terminal off the environment (`TERM_PROGRAM` and
 * friends); a gateway has no terminal, so it declares the one observed macOS
 * clients report.
 */
const MACOS_TERMINAL = "Apple_Terminal/455";

/** Anthropic Stainless spells it `MacOS`, without the space. */
const STAINLESS_OS = "MacOS";
const STAINLESS_ARCH = "arm64";

/** Kimi's device-model triple: "<OS> <release> <arch>". */
const KIMI_DEVICE_MODEL = "macOS 24.6.0 arm64";
const KIMI_OS_VERSION = "macOS 15.6";

/**
 * Kimi's device name, i.e. the hostname.
 *
 * A gateway's hostname is assigned by the VPS provider and routinely reads
 * `vps-a1b2c3` or `srv-04`, which identifies the deployment far more sharply
 * than an OS string does. Distinguishing accounts is `X-Msh-Device-Id`'s job,
 * not the hostname's.
 */
const KIMI_DEVICE_NAME = "MacBook-Pro.local";

/** Qoder's `cosy-machineos`: "<arch>_<os>". */
const QODER_MACHINE_OS = "aarch64_macos";


/**
 * Cline's `x-platform` / `x-platform-version`.
 *
 * Cline's own quota path already reports the literal `server` here, so the
 * dispatch path matches it rather than sending the host's `process.platform`
 * — two Cline surfaces disagreeing about the same machine is exactly the
 * split this module exists to close.
 */
const CLINE_PLATFORM = "darwin";
const CLINE_PLATFORM_VERSION = "v24.0.0";
/** Grok's own vocabulary — lowercase OS name, and `aarch64` not `arm64`. */
const GROK_OS = "macos";
const GROK_ARCH = "aarch64";

/**
 * Builds a Codex CLI user agent: `codex_cli_rs/0.160.0 (Mac OS 27.0.1; arm64)
 * Apple_Terminal/455`.
 *
 * Mirrors `get_codex_user_agent` in Codex's own `login` crate — same field
 * order, same separators — so the value is indistinguishable from the real
 * client's.
 */
export function buildCodexUserAgent(version: string): string {
  return `codex_cli_rs/${version} (${MACOS_NAME} ${MACOS_VERSION}; ${STAINLESS_ARCH}) ${MACOS_TERMINAL}`;
}

/**
 * Builds a Grok shell user agent: `grok-shell/0.2.93 (macos; aarch64)`.
 *
 * Mirrors `UserAgent::render` in `xai-grok-http` for the case where the
 * origin client and the agent are the same product.
 */
export function buildGrokShellUserAgent(version: string): string {
  return `grok-shell/${version} (${GROK_OS}; ${GROK_ARCH})`;
}

/**
 * Builds the Grok auth user agent: `grok-pager/0.2.93 grok-shell/0.2.93
 * (macos; aarch64)`.
 *
 * The pager prefix is what the token and billing endpoints see; it renders
 * the origin product ahead of the agent product, per the same renderer.
 */
export function buildGrokAuthUserAgent(version: string): string {
  return `grok-pager/${version} ${buildGrokShellUserAgent(version)}`;
}

/** The Anthropic Stainless OS value (`X-Stainless-OS`). */
export function stainlessOs(): string {
  return STAINLESS_OS;
}

/** The Anthropic Stainless architecture value (`X-Stainless-Arch`). */
export function stainlessArch(): string {
  return STAINLESS_ARCH;
}

/** Kimi's `X-Msh-Device-Model`. */
export function kimiDeviceModel(): string {
  return KIMI_DEVICE_MODEL;
}

/** Kimi's `X-Msh-Os-Version`. */
export function kimiOsVersion(): string {
  return KIMI_OS_VERSION;
}

/** Kimi's `X-Msh-Device-Name`. */
export function kimiDeviceName(): string {
  return KIMI_DEVICE_NAME;
}

/** Qoder's `cosy-machineos`. */
export function qoderMachineOs(): string {
  return QODER_MACHINE_OS;
}

/** Cline's `x-platform`. */
export function clinePlatform(): string {
  return CLINE_PLATFORM;
}

/** Cline's `x-platform-version`: a Node version string. */
export function clinePlatformVersion(): string {
  return CLINE_PLATFORM_VERSION;
}
