import type { ValidatedOutboundFetch } from "../provider-registry";

/**
 * Probe fetch wrapper: merges `Request`-carried headers with per-call init
 * headers before delegating to the validated fetch. Required wherever the
 * fetch is handed to adapters as `outbound_fetch`, because adapters may call
 * it with a `Request` whose headers would otherwise be dropped.
 */
export function createProbeFetch(fetcher: ValidatedOutboundFetch): ValidatedOutboundFetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    return fetcher(input, { ...init, headers });
  };
}
