import type { ValidatedOutboundFetch } from "../provider-registry";

/** Removes any caller-supplied User-Agent while preserving the validated fetch contract. */
export function createProbeFetch(fetcher: ValidatedOutboundFetch): ValidatedOutboundFetch {
  return (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete("user-agent");
    return fetcher(input, { ...init, headers });
  };
}
