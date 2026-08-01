/**
 * Factory for OpenCode-family providers (Free and Zen).
 *
 * Both providers share the same base URL, catalog, and request shape. The
 * only differences are: whether a credential is required, and what the
 * Authorization header value is. The factory captures those differences in
 * a config object and produces a fully-conforming Provider.
 */

import type { RouteTarget } from "../../routing/types";
import { ProviderCallError } from "./index";
import type { Provider, ProviderRequest, ProviderResult, ResolvedCredential } from "./index";
import { decodeOpenAIChatStream, decodeAnthropicStream } from "../bridge";
import { callSimpleProvider } from "./simple-call";
import {
  fetchOpenCodeCatalog,
  findOpenCodeModel,
  selectCapability,
} from "./opencode-catalog";
import { capabilityToSurface, surfaceToCapability, capabilityPath } from "./opencode-capability";
import type { ProviderModelCatalog } from "./models";

const UPSTREAM_BASE_URL = "https://opencode.ai/zen/v1";

export interface OpenCodeProviderConfig {
  id: Provider["id"];
  name: string;
  icon: string;
  authKind: "none" | "api-key";
  authHint: string;
  credentialUrl?: string;
  credentialKind: "none" | "provider-bearer";
  models: ProviderModelCatalog;
  /** Produces the Authorization header value. Called with the credential value (empty string for "none" providers). */
  authorizationHeader: (credentialValue: string) => string;
  /** Optional extra guard run before catalog fetch. Throw ProviderCallError to reject early. */
  validateCredential?: (credential: ResolvedCredential) => void;
}

class OpenCodeProvider implements Provider {
  readonly id: Provider["id"];
  readonly display: Provider["display"];
  readonly models: ProviderModelCatalog;

  constructor(private readonly cfg: OpenCodeProviderConfig) {
    this.id = cfg.id;
    this.display = {
      name: cfg.name,
      icon: cfg.icon,
      authKind: cfg.authKind,
      authHint: cfg.authHint,
      ...(cfg.credentialUrl ? { credentialUrl: cfg.credentialUrl } : {}),
    };
    this.models = cfg.models;
  }

  async resolveTarget(modelId: string): Promise<RouteTarget | undefined> {
    const catalog = await fetchOpenCodeCatalog();
    const entry = findOpenCodeModel(catalog, modelId);
    if (!entry) return undefined;

    const capability = selectCapability(entry, "chat");
    if (!capability) return undefined;

    return {
      provider: this.cfg.id,
      modelId,
      surface: capabilityToSurface(capability),
      credential: this.cfg.credentialKind,
      weight: 1,
    };
  }

  async call(
    target: RouteTarget,
    request: ProviderRequest,
    credential: ResolvedCredential,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    this.cfg.validateCredential?.(credential);

    const catalog = await fetchOpenCodeCatalog();
    const entry = findOpenCodeModel(catalog, target.modelId);
    if (!entry) {
      throw new ProviderCallError(
        400, "invalid_request",
        `The requested ${this.cfg.name} model is not available.`,
      );
    }

    const requestedCapability = surfaceToCapability(request.surface);
    const capability = selectCapability(entry, requestedCapability) ?? selectCapability(entry, "chat");
    if (!capability) {
      throw new ProviderCallError(
        400, "invalid_request",
        `The requested ${this.cfg.name} model does not support this API surface.`,
      );
    }

    if (capability !== "chat" && capability !== "messages") {
      throw new ProviderCallError(
        501, "invalid_request",
        `${this.cfg.name} responses capability is not yet implemented.`,
      );
    }

    const body = { ...request.body, model: target.modelId };

    return callSimpleProvider({
      url: `${UPSTREAM_BASE_URL}${capabilityPath(capability)}`,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: this.cfg.authorizationHeader(credential.value),
        "x-opencode-client": "desktop",
      },
      body,
      signal,
      providerLabel: this.cfg.name,
      isStreaming: (body as Record<string, unknown>).stream === true,
      decodeStream: capability === "chat" ? decodeOpenAIChatStream : decodeAnthropicStream,
    });
  }
}

/** Creates a Provider for an OpenCode-family endpoint. */
export function createOpenCodeProvider(cfg: OpenCodeProviderConfig): Provider {
  return new OpenCodeProvider(cfg);
}
