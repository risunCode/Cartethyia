interface RouteAcl {
  readonly providerAllowlist?: readonly string[] | null;
  readonly modelAllowlist?: readonly string[] | null;
  readonly modelDenylist?: readonly string[] | null;
}

function matches(value: string, candidate: string): boolean {
  return value === candidate || value === "*";
}

function allowedByList(list: readonly string[] | null | undefined, values: readonly string[]): boolean {
  if (list === null || list === undefined || list.length === 0) return true;
  return list.some((entry) => values.some((value) => matches(entry, value)));
}

export function isRouteAllowed(providerId: string, modelId: string, authorization: RouteAcl): boolean {
  const qualified = `${providerId}/${modelId}`;
  if (!allowedByList(authorization.providerAllowlist, [providerId])) return false;
  if (!allowedByList(authorization.modelAllowlist, [modelId, qualified])) return false;
  if ((authorization.modelDenylist ?? []).some((entry) => [modelId, qualified].some((value) => matches(entry, value)))) return false;
  return true;
}
