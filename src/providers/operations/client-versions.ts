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
  type ClientVersionFetcher,
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

async function kiroVersion(response: Response): Promise<string | null> {
  const body = await response.text();
  const version =
    /currentVersion["\\]*\s*:\s*["\\]*([\d.]+)/.exec(body)?.[1] ??
    /\bIDE\s+([\d.]+)[^<]*Latest/.exec(body)?.[1];
  return isSemverish(version) ? version : null;
}

/**
 * Runtime SDK version stamped into the Kiro data-plane User-Agent.
 *
 * Pinned rather than discovered: the generation surface is served by the client
 * the IDE ships, not by a release we can track, so the shipped build is the
 * only source of truth. The agent compiles its generation client from
 * `@aws/codewhisperer-streaming-client`, and that package's own version is the
 * value the client stamps.
 *
 * How to rediscover it — take it from the shipped build, never from guesswork:
 *   1. The IDE installer lives on the vendor's download feed, under a path that
 *      repeats the version:
 *      `https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/<v>/kiro-ide-<v>-stable-win32-x64.exe`
 *   2. Unpack it. The exe's payload is an LZMA stream behind a 4-byte tag:
 *      `7z x` the exe, drop the 4-byte tag from the extracted `[0]`, then
 *      `7z x` that as LZMA.
 *   3. In the unpacked payload, locate the agent bundle — the region defining
 *      `getCodeWhispererStreamingClient` — and read the aliased package
 *      metadata inside it: `"@aws/codewhisperer-streaming-client" … version:"x.y.z"`.
 *      Use that one. One installer also embeds other bundles carrying older
 *      copies of the same package, so a bare version match is not evidence.
 *
 * The discovery source below only supplies the *IDE* version that follows the
 * `KiroIDE` device marker.
 */
const KIRO_RUNTIME_SDK_VERSION = "1.0.39";

/**
 * AWS SSO OIDC SDK version stamped into login and token-refresh User-Agents.
 *
 * Distinct from the runtime SDK above because the upstream sees them as two
 * different AWS SDK clients: `oidc.{region}.amazonaws.com` is served by
 * `aws-sdk-js` sso-oidc, while the generation surface reports the
 * `codewhispererstreaming` client.
 */
const KIRO_SSO_SDK_VERSION = "3.980.0";

/**
 * Runtime segments the observed Kiro client reports.
 *
 * `win32#<build>` is the host Windows release, so it varies by machine and this
 * is the shape a Windows 11 client produces.
 *
 * The `md/nodejs#` segment is the runtime the client executes under, not the
 * host's Node: the IDE is an Electron app, so it is Electron's bundled Node.
 * Rediscover both from the same unpacked payload — the app's `package.json`
 * pins `"electron": "<version>"`, and that Electron release's metadata gives
 * the Node version to stamp here.
 */
const KIRO_SYSTEM_VERSION = "win32#10.0.22631";
/** Node version the observed Kiro client reports (Electron's bundled Node). */
const KIRO_NODE_VERSION = "24.18.0";

/** Ordered upstream sources and pinned fallbacks for every client version. */
export const VERSION_SOURCES = {
  qoder: {
    key: "qoder",
    fallback: "1.1.65",
    sources: [
      {
        url: "https://registry.npmjs.org/@qoder-ai/qodercli/latest",
        extract: qoderVersion,
      },
    ],
  },
  opencode: {
    key: "opencode",
    fallback: "1.18.33",
    sources: [{ url: "https://registry.npmjs.org/opencode-ai/latest" }],
  },
  commandcode: {
    key: "commandcode",
    fallback: "1.73.0",
    sources: [{ url: "https://registry.npmjs.org/command-code/latest" }],
  },
  grok: {
    key: "grok",
    fallback: "1.0.44",
    sources: [
      { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable" },
      { url: "https://registry.npmjs.org/@xai-official/grok/latest" },
    ],
  },
  clineClient: {
    key: "cline-client",
    fallback: "4.1.22",
    minVersion: "4.1.22",
    sources: [
      {
        url: "https://raw.githubusercontent.com/cline/cline/main/apps/vscode/package.json",
        extract: clineClientVersion,
      },
    ],
  },
  clineSdk: {
    key: "cline-sdk",
    fallback: "0.0.88",
    sources: [{ url: "https://registry.npmjs.org/@cline/sdk/latest", extract: clineSdkVersion }],
  },
  codex: {
    key: "codex",
    fallback: "0.159.2",
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
    fallback: "2.161.0",
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
  kiro: {
    key: "kiro",
    fallback: "1.2.4",
    sources: [{ url: "https://kiro.dev/downloads/", extract: kiroVersion }],
  },
  codebuddy: {
    key: "codebuddy",
    fallback: "2.161.0",
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
    fallback: "2.1.286",
    sources: [{ url: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest" }],
  },
  claudeSdk: {
    key: "claude-sdk",
    // The `@anthropic-ai/sdk` version *bundled inside the Claude Code
    // release* — the value stamped into the OAuth refresh User-Agent template
    // (`anthropic-sdk-typescript/{claude_code_sdk_version} userOAuthProvider`).
    // npm's standalone SDK is a different release line and is deliberately not
    // discovered: it would advertise a version Claude Code never bundled. Bump
    // alongside the CLI. Read it from the shipped native binary, which defines
    // the version string the template interpolates — never from guesswork.
    fallback: "0.127.0",
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
  kiro: createClientVersionResolver(VERSION_SOURCES.kiro),
} satisfies Record<keyof typeof VERSION_SOURCES, ClientVersionResolver>;

/**
 * The accessors every table entry needs, generated from its resolver.
 *
 * Each entry used to ship a hand-written `getX` / `resolveX` / `refreshX` /
 * `_resetX` quadruple that all did exactly this — four bodies per entry, which
 * is how a new entry could forget one or drift on which resolver it reads.
 * `accessor(name)` is the one place the shape is decided.
 *
 * A named export is still declared beside the table when callers read better
 * with it (`getCodexVersion`), or when the accessor seeds more than one
 * resolver (`_resetClaudeVersionCache`). Both are one line against a resolver,
 * not a second implementation.
 */
function accessor<K extends keyof typeof resolvers>(name: K): {
  readonly get: () => string;
  readonly resolve: (fetcher?: typeof fetch, signal?: AbortSignal) => Promise<string>;
  readonly refresh: (fetcher?: typeof fetch) => void;
  readonly reset: (version?: string | null) => void;
} {
  const resolver = resolvers[name];
  return {
    get: () => resolver.get(),
    resolve: async (fetcher?: typeof fetch, signal?: AbortSignal) => {
      await resolver.ensure(fetcher, signal);
      return resolver.get();
    },
    refresh: (fetcher?: typeof fetch) => {
      resolver.refresh(fetcher);
    },
    reset: (version?: string | null) => {
      resolver.reset(version);
    },
  };
}

export const getQoderVersion = accessor("qoder").get;
export const resolveQoderVersion = accessor("qoder").resolve;
export const _resetQoderVersion = accessor("qoder").reset;

export const getOpenCodeVersion = accessor("opencode").get;
export const resolveOpenCodeVersion = accessor("opencode").resolve;
export const refreshOpenCodeVersion = accessor("opencode").refresh;
export const _resetOpenCodeVersion = accessor("opencode").reset;

export const getCommandCodeVersion = accessor("commandcode").get;
export const resolveCommandCodeVersion = accessor("commandcode").resolve;
export const _resetCommandCodeVersion = accessor("commandcode").reset;

export const getGrokVersion = accessor("grok").get;
export const resolveGrokVersion = accessor("grok").resolve;
export const refreshGrokVersion = accessor("grok").refresh;

export function buildGrokUserAgent(version = getGrokVersion()): string {
  return `grok-shell/${version} (linux; x86_64)`;
}

export function buildGrokAuthUserAgent(version = getGrokVersion()): string {
  return `grok-pager/${version} grok-shell/${version} (linux; x86_64)`;
}

export const _resetGrokVersionCache = accessor("grok").reset;

export const getClineClientVersion = accessor("clineClient").get;
export const getClineSdkVersion = accessor("clineSdk").get;
export const resolveClineClientVersion = accessor("clineClient").resolve;
export const resolveClineSdkVersion = accessor("clineSdk").resolve;
export const refreshClineClientVersion = accessor("clineClient").refresh;

export const resolveWorkBuddyClientVersion = accessor("workbuddyClient").resolve;
export const _resetWorkBuddyClientVersionCache = accessor("workbuddyClient").reset;

export const getCodexVersion = accessor("codex").get;
export const resolveCodexVersion = accessor("codex").resolve;
export const refreshCodexVersion = accessor("codex").refresh;
export const _resetCodexVersion = accessor("codex").reset;

export const getWorkBuddyClientVersion = accessor("workbuddyClient").get;
export const getWorkBuddyCliVersion = accessor("workbuddyCli").get;

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

export const _resetWorkBuddyVersionCache = accessor("workbuddyCli").reset;

export const getKimiCliVersion = accessor("kimiCli").get;
export const resolveKimiCliVersion = accessor("kimiCli").resolve;
export const refreshKimiCliVersion = accessor("kimiCli").refresh;
export const _resetKimiCliVersion = accessor("kimiCli").reset;

export const getCodeBuddyVersion = accessor("codebuddy").get;
export const resolveCodeBuddyVersion = accessor("codebuddy").resolve;

export function buildCodeBuddyUserAgent(
  identity: "IDE" | "CLI",
  version = getCodeBuddyVersion(),
): string {
  return `${identity}/${version} CodeBuddy/${version}`;
}

export const _resetCodeBuddyVersionCache = accessor("codebuddy").reset;

export const getClaudeCliVersion = accessor("claudeCli").get;
export const resolveClaudeCliVersion = accessor("claudeCli").resolve;
export const getClaudeSdkVersion = accessor("claudeSdk").get;
export const resolveClaudeSdkVersion = accessor("claudeSdk").resolve;

export function _resetClaudeVersionCache(version: string | null = null): void {
  resolvers.claudeCli.reset(version);
  resolvers.claudeSdk.reset(version);
}

export const getKiroVersion = accessor("kiro").get;
// Kiro's callers pass its own `FetchLike` (a narrower fetch surface), so the
// generated signature is widened here rather than at the factory.
export const resolveKiroVersion = accessor("kiro").resolve as (
  fetcher?: ClientVersionFetcher,
  signal?: AbortSignal,
) => Promise<string>;
export const _resetKiroVersion = accessor("kiro").reset;

/**
 * Builds the `x-amz-user-agent` companion header for the generation surface.
 *
 * The upstream pairs this with `user-agent` on every generation request; the
 * short form carries the SDK identity and the `KiroIDE-{version}-{machineId}`
 * device marker and nothing else.
 */
export function buildKiroAmzUserAgent(version = getKiroVersion(), machineId = ""): string {
  return `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} KiroIDE-${version}-${machineId}`;
}

/**
 * Builds the full data-plane `user-agent`.
 *
 * Shape: SDK version, `ua/2.1`, the OS and node segments, the API and module
 * markers, and the `KiroIDE-{version}-{machineId}` device marker. The device
 * marker is the part the upstream correlates on, so it is never omitted — a
 * blank machine id advertises the account as a device with no identity, which
 * is a shape no real client produces.
 */
export function buildKiroUserAgent(version = getKiroVersion(), machineId = ""): string {
  return (
    `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_SYSTEM_VERSION} lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/codewhispererstreaming#${KIRO_RUNTIME_SDK_VERSION} m/E ` +
    `KiroIDE-${version}-${machineId}`
  );
}

/**
 * Builds the `x-amz-user-agent` companion for an AWS SSO OIDC request.
 *
 * The login and token-refresh surfaces are served by a different AWS SDK
 * client, so they carry that client's version and no device marker — the
 * observed client does not send one there.
 */
export function buildKiroSsoAmzUserAgent(): string {
  return `aws-sdk-js/${KIRO_SSO_SDK_VERSION} KiroIDE`;
}

/** Builds the full `user-agent` for an AWS SSO OIDC request. */
export function buildKiroSsoUserAgent(): string {
  return (
    `aws-sdk-js/${KIRO_SSO_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_SYSTEM_VERSION} lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/sso-oidc#${KIRO_SSO_SDK_VERSION} m/E KiroIDE`
  );
}

/**
 * Builds the browser-shaped `user-agent` the vendor portal expects.
 *
 * The portal's approval endpoints are same-origin XHRs issued by the SSO start
 * page, so they are only ever reached by a browser.
 */
export function buildKiroBrowserUserAgent(): string {
  const platform = KIRO_SYSTEM_VERSION.split("#")[0];
  const os =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "linux"
        ? "X11; Linux x86_64"
        : "Windows NT 10.0; Win64; x64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`;
}

/**
 * Builds the `user-agent` the model-catalog and usage surfaces expect.
 *
 * Their observed client identifies as `codewhispererruntime` rather than
 * `codewhispererstreaming`, and carries the `m/N,E` module marker.
 */
export function buildKiroRuntimeUserAgent(version = getKiroVersion(), machineId = ""): string {
  return (
    `aws-sdk-js/${KIRO_RUNTIME_SDK_VERSION} ua/2.1 ` +
    `os/${KIRO_SYSTEM_VERSION} lang/js md/nodejs#${KIRO_NODE_VERSION} ` +
    `api/codewhispererruntime#${KIRO_RUNTIME_SDK_VERSION} m/N,E ` +
    `KiroIDE-${version}-${machineId}`
  );
}
