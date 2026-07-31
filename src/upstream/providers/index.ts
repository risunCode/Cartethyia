/**
 * Unified upstream provider module — re-exports only.
 *
 * Every consumer imports from this file; the actual definitions live in:
 *   types.ts   — Provider, ProviderRequest, ProviderResult, etc.
 *   errors.ts  — ProviderCallError, providerHttpError, safeReadText, etc.
 *   registry.ts — providerRegistry, PROVIDERS Map
 */

export type { ResolvedCredential, ProviderRequest, ProviderStreamResult, ProviderJsonResult, ProviderResult, ProviderDisplay, Provider } from "./types";
export { UpstreamError, ProviderCallError, classifyUpstreamStatus, safeReadText, extractUpstreamErrorMessage, providerHttpError } from "./errors";
export { providerRegistry } from "./registry";
