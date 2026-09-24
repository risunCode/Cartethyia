/**
 * Dedicated `claude` adapter.
 *
 * Wire mechanics live in `src/protocol/`:
 *   - `protocol/primitives.ts`         shared guards, tool-id/schema/tool-name helpers, endpoint URL
 *   - `protocol/request/messages.ts`   canonical -> Claude Messages body
 *   - `protocol/response/messages.ts`  Claude JSON/SSE -> canonical events
 *   - `protocol/transport/messages.ts` shared HTTP send helper
 *   - `errors.ts`   upstream HTTP error -> `GatewayError`
 *   - `policy.ts`   header/beta/credential policy (unchanged)
 *   - `cch.ts`      CCH billing-header body patch (unchanged)
 *
 * Bespoke by wire protocol (Phase C5): the Claude Messages envelope
 * (thinking blocks, cache_control, beta negotiation) is outside the
 * OpenAI-compatible factory's reach — stays bespoke, never re-audit.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CanonicalEvent, CanonicalRequest } from "../../../transport/canonical-model";
import { GatewayError } from "../../../transport/gateway-error";
import { firstUserText, getHeader } from "../../../transport/canonical-model";
import { log } from "../../../observability/logger";
import {
  assessClaudeCodeCompatibility,
  assertClaudeCodeCompatibility,
  requestHasClaudeTools,
} from "./claude-compatibility";
import { buildClaudeHeaders, type ClaudeHeaderOptions } from "./claude-credentials";
import { isRecord } from "../../../protocol/primitives";
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import { ensureAnthropicBeta, filterClaudeCustomHeaders } from "../claude-messages";
import {
  CLAUDE_CODE_SYSTEM_INSTRUCTION,
  createClaudeBillingText,
  patchClaudeCchBody,
} from "./claude-cch";
import { resolveClaudeCliVersion, resolveClaudeSdkVersion } from "../../operations/client-versions";
import { canonicalToClaudeMessagesPayload } from "../../../protocol/request/messages";
import { CLAUDE_BILLING_HEADER_PREFIX, endpointUrl } from "../../../protocol/primitives";
import { sendClaudeMessagesRequest } from "../../../protocol/transport/messages";
import type {
  ProviderDispatchTarget,
  ProviderAdapter,
  ProviderDispatchContext,
} from "../../provider-registry";
import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";

const claudeMessagesModel = (
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  reasoning: boolean,
): ModelDefinition =>
  defineModel({
    id: modelId,
    wireFamily: "messages",
    endpoint: "/v1/messages",
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning,
    toolCall: true,
    webSearch: true,
  });

export const CLAUDE_MODELS: readonly ModelDefinition[] = [
  claudeMessagesModel("claude-fable-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-fable-5-1", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-mythos-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-mythos-5-1", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-5-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-8", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-7", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-6", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-sonnet-5", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-sonnet-4-6", 1_000_000, 128_000, true),
  claudeMessagesModel("claude-opus-4-5", 200_000, 64_000, true),
  claudeMessagesModel("claude-sonnet-4-5", 1_000_000, 64_000, true),
  claudeMessagesModel("claude-haiku-4-5", 200_000, 64_000, true),
  claudeMessagesModel("claude-opus-4-1", 200_000, 32_000, true),
  claudeMessagesModel("claude-3-7-sonnet", 200_000, 64_000, false),
];




const CLAUDE_DEVICE_ID_DOMAIN = "cartethyia-claude-device-id-v1";

function claudeInstallIdPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return join(home, ".cartethyia", "claude-install-id");
}

/**
 * Stable per-installation id, persisted once like the Codex install id. The
 * the assistant metadata `device_id` is derived from it so a machine keeps one
 * identity across restarts instead of minting a new one per request.
 */
async function getClaudeInstallId(): Promise<string> {
  const path = claudeInstallIdPath();
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${id}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return id;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return (await readFile(path, "utf8")).trim();
  }
}

/** The stable device id the assistant metadata carries for this installation. */
export async function claudeDeviceId(accountId?: string): Promise<string> {
  const hash = createHash("sha256").update(CLAUDE_DEVICE_ID_DOMAIN).update("\0").update(await getClaudeInstallId());
  if (accountId !== undefined && accountId.length > 0) hash.update("\0").update(accountId);
  return hash.digest("hex");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Whether a caller-supplied user id is already in an accepted shape: the
 * cloaked `user_<64hex>_account_<uuid>_session_<uuid>` form, or a JSON
 * envelope carrying a non-empty `session_id`.
 */
export function isClaudeMetadataUserId(value: string): boolean {
  if (/^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/i.test(value)) return true;
  if (!value.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      isRecord(parsed) &&
      typeof parsed["session_id"] === "string" &&
      (parsed["session_id"] as string).length > 0
    );
  } catch {
    return false;
  }
}

/** Adapter construction options used by deterministic local tests and custom endpoints. */
interface ClaudeAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly base_url?: string;
  readonly custom_headers?: Readonly<Record<string, unknown>>;
}

/**
 * Claude Code CLI impersonation adapter: builds Claude-branded headers via
 * `buildClaudeHeaders`, negotiates beta features, applies CCH billing-header
 * injection, and biases the payload/endpoint for OAuth-style credentials.
 * `provider_id` is always `"claude"` — plain Anthropic API-key traffic uses
 * `AnthropicApiKeyAdapter` instead, which never touches this impersonation
 * machinery.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider_id = "claude" as const;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string | undefined;
  private readonly customHeaders: Readonly<Record<string, unknown>> | undefined;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.base_url;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "messages") {
      throw new GatewayError(
        "capability_unsupported",
        400,
        "claude supports messages only",
      );
    }
    if (
      context.credential.credential_kind !== "oauth" &&
      context.credential.credential_kind !== "scoped_access_token"
    ) {
      throw new GatewayError(
        "invalid_request",
        400,
        `claude: the assistant OAuth credential required (got credential_kind=${context.credential.credential_kind})`,
      );
    }
    const customHeaders = filterClaudeCustomHeaders({
      ...this.customHeaders,
      ...context.credential.custom_headers,
    });
    const isClaudeCodeOAuth =
      context.credential.credential_kind === "oauth" ||
      context.credential.credential_kind === "scoped_access_token";
    const incomingBeta = getHeader(context.request_headers, "anthropic-beta");
    const assessment = assessClaudeCodeCompatibility(request, {
      capabilities: candidate.capabilities,
      beta_header: incomingBeta,
      beta_policy: "reject",
      credential_kind: context.credential.credential_kind,
      target_provider: "claude",
    });
    assertClaudeCodeCompatibility(assessment);
    const hasThinking =
      request.reasoning !== undefined &&
      request.reasoning.thinking_type !== "disabled";
    const hasTools = requestHasClaudeTools(request);
    const [cliVersion, sdkVersion] = await Promise.all([
      resolveClaudeCliVersion(),
      resolveClaudeSdkVersion(),
    ]);
    const headerOptions: ClaudeHeaderOptions = {
      credential_kind: context.credential.credential_kind,
      custom_headers: customHeaders,
      capabilities: candidate.capabilities,
      unsupported_beta_policy: "reject",
      target_provider: "claude",
      has_thinking: hasThinking,
      has_tools: hasTools,
      stream: request.stream,
      cli_version: cliVersion,
      sdk_version: sdkVersion,
      ...(context.request_headers === undefined
        ? {}
        : { request_headers: context.request_headers }),
      ...(incomingBeta === undefined ? {} : { anthropic_beta: incomingBeta }),
    };
    const headers: Record<string, string> = buildClaudeHeaders(
      context.credential.secret,
      context.credential.account_id,
      headerOptions,
    );
    const profileId = request.generation_controls["extension:user_profile_id"];
    if (typeof profileId === "string" && profileId.length > 0)
      ensureAnthropicBeta(headers, "user-profiles");
    const sessionId = headers["X-Claude-Code-Session-Id"] ?? resolvePromptCacheKey(request);
    const payload = canonicalToClaudeMessagesPayload(request, {
      isOAuth: isClaudeCodeOAuth,
    });
    if (isClaudeCodeOAuth) {
      // Session attribution follows the reference rules: a valid caller id
      // travels verbatim; otherwise a JSON envelope is generated from the
      // resolved session identity (never a bare UUID, which matches neither
      // accepted grammar). API-key callers without an id send none.
      const callerUserId = request.generation_controls["extension:metadata_user_id"];
      if (typeof callerUserId === "string" && isClaudeMetadataUserId(callerUserId)) {
        payload.metadata = { user_id: callerUserId };
      } else if (sessionId !== undefined && sessionId.length > 0) {
        const accountUuid = isUuid(context.credential.account_id)
          ? context.credential.account_id
          : undefined;
        payload.metadata = {
          user_id: JSON.stringify({
            device_id: await claudeDeviceId(accountUuid),
            session_id: sessionId,
            ...(accountUuid === undefined ? {} : { account_uuid: accountUuid }),
          }),
        };
      }
      const system = Array.isArray(payload.system) ? payload.system : [];
      const userText = firstUserText(request);
      const billing = {
        type: "text",
        text: createClaudeBillingText(userText, cliVersion),
      };
      const instruction = {
        type: "text",
        text: CLAUDE_CODE_SYSTEM_INSTRUCTION,
        cache_control: { type: "ephemeral" },
      };
      const hasInstruction = system.some(
        (block) => isRecord(block) && block["text"] === CLAUDE_CODE_SYSTEM_INSTRUCTION,
      );
      const hasBilling = system.some(
        (block) =>
          isRecord(block) &&
          typeof block["text"] === "string" &&
          (block["text"] as string).startsWith(CLAUDE_BILLING_HEADER_PREFIX),
      );
      // Captured-client placement: billing first, instruction second. The
      // patch anchor assumes this order — never reorder around it.
      payload.system = [
        ...(hasBilling ? [] : [billing]),
        ...(hasInstruction ? [] : [instruction]),
        ...system,
      ];
    }
    const url = endpointUrl(
      this.baseUrl,
      candidate.endpoint_path || "/v1/messages",
      isClaudeCodeOAuth,
    );
    const requestBody = JSON.stringify(payload);
    const patchedBody = isClaudeCodeOAuth ? patchClaudeCchBody(requestBody) : undefined;
    if (isClaudeCodeOAuth && patchedBody === undefined) {
      // Unanchored billing block: warn and send as-is, exactly like the
      // reference client. Availability wins over attestation here — an
      // unattested send is the accepted fallback, a 500 is a self-DoS.
      log.warn("claude billing attestation unanchored; sending unattested", {
        provider: "claude",
      });
    }
    const outboundBody =
      patchedBody === undefined ? requestBody : new TextDecoder().decode(patchedBody);
    yield* sendClaudeMessagesRequest(
      url,
      headers,
      outboundBody,
      context,
      request,
      this.fetchFn,
      isClaudeCodeOAuth,
    );
  }
}

export const claudeAdapter = new ClaudeAdapter();

