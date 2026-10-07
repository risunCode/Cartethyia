/**
 * The two lines a failed model probe shows.
 *
 * The title names the model and the wire it was probed on; the body is only
 * the upstream sentence. The backend prefixes the body with the wire family
 * (`responses — …`) because that is the one fact the caller does not already
 * have — pulling it into the title keeps the body to the failure itself.
 */
export function probeFailureToast(
  providerId: string,
  modelId: string,
  error: string | null | undefined,
): { readonly title: string; readonly detail: string } {
  const text = error?.trim() ?? "";
  const split = text.indexOf(" — ");
  const wire = split > 0 ? text.slice(0, split) : "";
  const detail = split > 0 ? text.slice(split + 3) : text;
  const via = wire.length > 0 ? ` via ${wire}` : "";
  return {
    title: `${providerId}/${modelId} probe failed${via}`,
    detail: detail.length > 0 ? detail : "Unknown error",
  };
}

/** `toast.error` takes the two lines as separate arguments. */
export function probeFailureToastArgs(
  providerId: string,
  modelId: string,
  error: string | null | undefined,
): [string, string] {
  const { title, detail } = probeFailureToast(providerId, modelId, error);
  return [title, detail];
}
