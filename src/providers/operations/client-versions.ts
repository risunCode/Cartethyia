/**
 * Central client-version sources and resolvers for provider integrations.
 *
 * Every entry follows the same discovered → pinned fallback order.
 * Provider-specific header builders remain next to their integrations, while
 * the network source and resolver state live in this table.
 */
import {
  createClientVersionResolver,
  isSemverish,
  type ClientVersionResolver,
} from "./client-version-resolver";

async function qoderVersion(response: Response): Promise<string | null> {
  try {
    const parsed = (await response.json()) as { version?: unknown };
    return isSemverish(parsed.version) ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

async function clineClientVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as { version?: unknown };
  return isSemverish(data.version) ? data.version.trim() : null;
}

async function clineSdkVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as {
    version?: unknown;
    "dist-tags"?: { latest?: unknown };
  };
  const candidate = data.version ?? data["dist-tags"]?.latest;
  return isSemverish(candidate) ? candidate.trim() : null;
}

async function kimiVersion(response: Response): Promise<string | null> {
  const data = (await response.json()) as { info?: { version?: unknown } };
  return isSemverish(data.info?.version) ? data.info.version.trim() : null;
}

async function workbuddyDesktopVersion(response: Response): Promise<string | null> {
  try {
    const data = (await response.json()) as { version?: unknown; productVersion?: unknown };
    const candidate = data.productVersion ?? data.version;
    return typeof candidate === "string" && /^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(candidate.trim())
      ? candidate.trim()
      : null;
  } catch {
    return null;
  }
}

/** Ordered upstream sources and pinned fallbacks for every client version. */
export const VERSION_SOURCES = {
  qoder: {
    key: "qoder",
    fallback: "1.1.62",
    sources: [
      {
        url: "https://registry.npmjs.org/@qoder-ai/qodercli/latest",
        extract: qoderVersion,
      },
    ],
  },
  opencode: {
    key: "opencode",
    fallback: "1.18.32",
    sources: [{ url: "https://registry.npmjs.org/opencode-ai/latest" }],
  },
  commandcode: {
    key: "commandcode",
    fallback: "1.64.0",
    sources: [{ url: "https://registry.npmjs.org/command-code/latest" }],
  },
  grok: {
    key: "grok",
    fallback: "1.0.41",
    sources: [
      { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable" },
      { url: "https://registry.npmjs.org/@xai-official/grok/latest" },
    ],
  },
  clineClient: {
    key: "cline-client",
    fallback: "4.1.20",
    minVersion: "4.1.20",
    sources: [
      {
        url: "https://raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json",
        extract: clineClientVersion,
      },
    ],
  },
  clineSdk: {
    key: "cline-sdk",
    fallback: "0.0.85",
    sources: [{ url: "https://registry.npmjs.org/@cline/sdk/latest", extract: clineSdkVersion }],
  },
  codex: {
    key: "codex",
    fallback: "0.156.1",
    sources: [{ url: "https://registry.npmjs.org/@openai/codex/latest" }],
  },
  workbuddyClient: {
    key: "workbuddy-client",
    fallback: "5.6.2.39458645",
    sources: [
      {
        url: "https://www.workbuddy.ai/v2/update?platform=workbuddy-win32-x64-user",
        extract: workbuddyDesktopVersion,
      },
      {
        url: "https://www.workbuddy.ai/v2/update?platform=workbuddy-darwin-arm64",
        extract: workbuddyDesktopVersion,
      },
    ],
  },
  workbuddyCli: {
    key: "workbuddy",
    fallback: "2.157.0",
    sources: [
      { url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
      { url: "https://registry.npmmirror.com/@tencent-ai/codebuddy-code/latest" },
    ],
  },
  kimiCli: {
    key: "kimi-cli",
    fallback: "1.52.0",
    sources: [{ url: "https://pypi.org/pypi/kimi-cli/json", extract: kimiVersion }],
  },
  codebuddy: {
    key: "codebuddy",
    fallback: "2.157.0",
    sources: [
      { url: "https://registry.npmjs.org/@tencent-ai/codebuddy-code/latest" },
      { url: "https://registry.npmmirror.com/@tencent-ai/codebuddy-code/latest" },
    ],
  },
  claudeCli: {
    key: "claude-cli",
    // Current `@anthropic-ai/claude-code` release, so the billing
    // `cc_version=` suffix and the `claude-cli/` User-Agent stay on what
    // upstream ships.
    fallback: "2.1.280",
    sources: [{ url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest" }],
  },
  claudeSdk: {
    key: "claude-sdk",
    // The `@anthropic-ai/sdk` version *bundled inside the Claude Code
    // release* — the value stamped into the OAuth refresh User-Agent template
    // (`anthropic-sdk-typescript/{claude_code_sdk_version} userOAuthProvider`).
    // npm's standalone SDK is a different release line and is deliberately not
    // discovered: it would advertise a version Claude Code never bundled. Bump
    // alongside the CLI.
    fallback: "0.112.1",
    sources: [],
  },
} as const;

const resolvers = {
  qoder: createClientVersionResolver(VERSION_SOURCES.qoder),
  opencode: createClientVersionResolver(VERSION_SOURCES.opencode),
  commandcode: createClientVersionResolver(VERSION_SOURCES.commandcode),
  grok: createClientVersionResolver(VERSION_SOURCES.grok),
  clineClient: createClientVersionResolver(VERSION_SOURCES.clineClient),
  clineSdk: createClientVersionResolver(VERSION_SOURCES.clineSdk),
  codex: createClientVersionResolver(VERSION_SOURCES.codex),
  workbuddyClient: createClientVersionResolver(VERSION_SOURCES.workbuddyClient),
  workbuddyCli: createClientVersionResolver(VERSION_SOURCES.workbuddyCli),
  kimiCli: createClientVersionResolver(VERSION_SOURCES.kimiCli),
  codebuddy: createClientVersionResolver(VERSION_SOURCES.codebuddy),
  claudeCli: createClientVersionResolver(VERSION_SOURCES.claudeCli),
  claudeSdk: createClientVersionResolver(VERSION_SOURCES.claudeSdk),
} satisfies Record<keyof typeof VERSION_SOURCES, ClientVersionResolver>;

export function getQoderVersion(): string {
  return resolvers.qoder.get();
}

export async function resolveQoderVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.qoder.ensure(fetcher, signal);
  return getQoderVersion();
}

export function _resetQoderVersion(version: string | null = null): void {
  resolvers.qoder.reset(version);
}

export function getOpenCodeVersion(): string {
  return resolvers.opencode.get();
}

export function refreshOpenCodeVersion(fetcher?: typeof fetch): void {
  resolvers.opencode.refresh(fetcher);
}

export async function resolveOpenCodeVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.opencode.ensure(fetcher, signal);
  return getOpenCodeVersion();
}

export function _resetOpenCodeVersion(version: string | null = null): void {
  resolvers.opencode.reset(version);
}

export function getCommandCodeVersion(): string {
  return resolvers.commandcode.get();
}

export async function resolveCommandCodeVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.commandcode.ensure(fetcher, signal);
  return getCommandCodeVersion();
}

export function _resetCommandCodeVersion(version: string | null = null): void {
  resolvers.commandcode.reset(version);
}

export function getGrokVersion(): string {
  return resolvers.grok.get();
}

export async function resolveGrokVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.grok.ensure(fetcher, signal);
  return getGrokVersion();
}

export function refreshGrokVersion(fetcher?: typeof fetch): void {
  resolvers.grok.refresh(fetcher);
}

export function buildGrokUserAgent(version = getGrokVersion()): string {
  return `grok-shell/${version} (linux; x86_64)`;
}

export function buildGrokAuthUserAgent(version = getGrokVersion()): string {
  return `grok-pager/${version} grok-shell/${version} (linux; x86_64)`;
}

export function _resetGrokVersionCache(version: string | null = null): void {
  resolvers.grok.reset(version);
}

export function getClineClientVersion(): string {
  return resolvers.clineClient.get();
}

export function getClineSdkVersion(): string {
  return resolvers.clineSdk.get();
}

export async function resolveClineClientVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.clineClient.ensure(fetcher, signal);
  return getClineClientVersion();
}

export async function resolveClineSdkVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.clineSdk.ensure(fetcher, signal);
  return getClineSdkVersion();
}

export function refreshClineClientVersion(fetcher?: typeof fetch): void {
  resolvers.clineClient.refresh(fetcher);
}

export async function resolveWorkBuddyClientVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.workbuddyClient.ensure(fetcher, signal);
  return getWorkBuddyClientVersion();
}

export function _resetWorkBuddyClientVersionCache(version: string | null = null): void {
  resolvers.workbuddyClient.reset(version);
}

export function getCodexVersion(): string {
  return resolvers.codex.get();
}

export async function resolveCodexVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.codex.ensure(fetcher, signal);
  return getCodexVersion();
}

export function refreshCodexVersion(fetcher?: typeof fetch): void {
  resolvers.codex.refresh(fetcher);
}

export function _resetCodexVersion(version: string | null = null): void {
  resolvers.codex.reset(version);
}

export function getWorkBuddyClientVersion(): string {
  return resolvers.workbuddyClient.get();
}

export function getWorkBuddyCliVersion(): string {
  return resolvers.workbuddyCli.get();
}

export async function resolveWorkBuddyVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await Promise.all([
    resolvers.workbuddyClient.ensure(fetcher, signal),
    resolvers.workbuddyCli.ensure(fetcher, signal),
  ]);
  return getWorkBuddyCliVersion();
}

export function buildWorkBuddyUserAgent(
  clientVersion = getWorkBuddyClientVersion(),
  cliVersion = getWorkBuddyCliVersion(),
): string {
  return `WorkBuddy/${clientVersion} WorkBuddy AI/${clientVersion} CLI/${cliVersion}`;
}

export function _resetWorkBuddyVersionCache(version: string | null = null): void {
  resolvers.workbuddyCli.reset(version);
}

export function getKimiCliVersion(): string {
  return resolvers.kimiCli.get();
}

export async function resolveKimiCliVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.kimiCli.ensure(fetcher, signal);
  return getKimiCliVersion();
}

export function refreshKimiCliVersion(fetcher?: typeof fetch): void {
  resolvers.kimiCli.refresh(fetcher);
}

export function _resetKimiCliVersion(version: string | null = null): void {
  resolvers.kimiCli.reset(version);
}

export function getCodeBuddyVersion(): string {
  return resolvers.codebuddy.get();
}

export async function resolveCodeBuddyVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.codebuddy.ensure(fetcher, signal);
  return getCodeBuddyVersion();
}

export function buildCodeBuddyUserAgent(
  identity: "IDE" | "CLI",
  version = getCodeBuddyVersion(),
): string {
  return `${identity}/${version} CodeBuddy/${version}`;
}

export function _resetCodeBuddyVersionCache(version: string | null = null): void {
  resolvers.codebuddy.reset(version);
}

export function getClaudeCliVersion(): string {
  return resolvers.claudeCli.get();
}

export async function resolveClaudeCliVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.claudeCli.ensure(fetcher, signal);
  return getClaudeCliVersion();
}

export function getClaudeSdkVersion(): string {
  return resolvers.claudeSdk.get();
}

export async function resolveClaudeSdkVersion(fetcher?: typeof fetch, signal?: AbortSignal): Promise<string> {
  await resolvers.claudeSdk.ensure(fetcher, signal);
  return getClaudeSdkVersion();
}

export function _resetClaudeVersionCache(version: string | null = null): void {
  resolvers.claudeCli.reset(version);
  resolvers.claudeSdk.reset(version);
}
