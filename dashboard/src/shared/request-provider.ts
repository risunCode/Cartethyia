/**
 * Returns the provider a request names for display.
 *
 * A request can fail before a provider is leased, so the explicit provider id may
 * be absent. A qualified `provider/model` request still provides a displayable
 * provider id; a bare model names no provider.
 */
export function requestProviderId(
  providerId: string | undefined,
  model: string | undefined,
): string | undefined {
  if (providerId) return providerId;
  const slash = model === undefined ? -1 : model.indexOf("/");
  return slash > 0 ? model?.slice(0, slash) : undefined;
}
