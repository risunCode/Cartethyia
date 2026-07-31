import type { RouteTarget } from "../../routing/types";
import type { ProviderRequest } from "./index";
import type { OpenCodeCapability } from "./opencode-catalog";

/**
 * Surface/capability mapping shared by OpenCode Free and OpenCode Zen
 * both are the same opencode.ai/zen/v1 catalog, differing only in auth.
 */

export function capabilityToSurface(capability: OpenCodeCapability): RouteTarget["surface"] {
  if (capability === "chat") return "openai-chat";
  if (capability === "messages") return "anthropic-messages";
  return "openai-responses";
}

export function surfaceToCapability(surface: ProviderRequest["surface"]): OpenCodeCapability {
  if (surface === "openai-chat") return "chat";
  if (surface === "anthropic-messages") return "messages";
  return "responses";
}

export function capabilityPath(capability: OpenCodeCapability): string {
  if (capability === "chat") return "/chat/completions";
  if (capability === "messages") return "/messages";
  return "/responses";
}
