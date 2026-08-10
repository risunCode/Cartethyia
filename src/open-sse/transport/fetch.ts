import { sanitizeMessage, type NetworkSelection } from "../../application/contracts";
import { buildProxyFetcher } from "../../traffic";
import { fetchWithRedirectPolicy } from "../../security/redirect-policy";
import { assertPublicUrlAtDispatch } from "../../security/ssrf-guard";
import { AbortCoordinator } from "./abort-coordinator";
import { ProviderAdapterError } from "./errors";
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}


// ---------------------------------------------------------------- HTTP plumbing

/**
 * Executes a real fetch bound to the coordinator signal. Connect-phase
 * timeouts surface as network_unavailable (routeScope "proxy"); caller
 * aborts as client_aborted; transport failures as network_unavailable.
 */


export async function executeFetch(url: string, init: RequestInit, coordinator: AbortCoordinator, network?: NetworkSelection, capture?: { request(value: unknown): void; observeResponse(response: Response): Response }): Promise<Response> {
  try {
    const requestInit = { ...init, signal: coordinator.signal };
    if (init.body !== undefined) capture?.request(typeof init.body === "string" ? init.body : String(init.body));
    // Direct (non-proxied) fetches follow redirects manually so every redirect
    // hop is re-validated through the SSRF guard — a safe initial URL must not
    // be able to redirect to a private/internal target. The initial URL is
    // already validated at the application layer (custom providers) or is a
    // trusted hardcoded constant (built-in providers), so the validator only
    // checks redirect targets, not the first hop. The proxy path tunnels
    // through the SOCKS5/HTTP relay, where the proxy egress (not local DNS)
    // resolves redirect targets, so it keeps native redirect handling.
    let firstHop = true;
    const response = network?.url === null || network?.url === undefined
      ? await fetchWithRedirectPolicy(url, requestInit, {
          validator: (target) => {
            if (firstHop) {
              firstHop = false;
              return;
            }
            return assertPublicUrlAtDispatch(target, { label: "upstream redirect target" }).then(() => {});
          },
        })
      : await buildProxyFetcher({ url: network.url, isRelay: network.isRelay })(url, requestInit);
    coordinator.markHeadersReceived();
    return capture?.observeResponse(response) ?? response;
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    if (isAbortError(error)) {
      if (coordinator.causeOf() === "caller") {
        throw new ProviderAdapterError({ kind: "client_aborted", message: "Request aborted by caller", retryable: false, routeScope: null });
      }
      throw new ProviderAdapterError({ kind: "network_unavailable", message: "Upstream connection timed out", retryable: true, routeScope: "proxy" });
    }
    throw new ProviderAdapterError({ kind: "network_unavailable", message: sanitizeMessage(error), retryable: true, routeScope: "proxy" });
  }
}