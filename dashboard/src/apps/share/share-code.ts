/**
 * Public-share error copy, owned by the share app.
 *
 * A share link's failure is the one surface a recipient sees with no console
 * behind it, so the gateway's code has to read as an instruction rather than a
 * status: `link_disabled` is not "the link is dead" — the link and the key both
 * still exist, and the recipient should ask for the key to be re-enabled.
 * An unknown code yields `undefined` so the caller can fall back to the raw
 * message rather than showing a wrong instruction confidently.
 */

/** Maps public-share error codes to safe user-facing copy; unknown codes yield undefined. */
export function shareCodeMessage(code: string | undefined): string | undefined {
  if (code === "link_expired_or_used") return "This enrollment link has expired or has already been used.";
  if (code === "key_unavailable") return "The shared access template is no longer available.";
  if (code === "link_not_found") return "This enrollment link is unavailable.";
  // A paused key is the one refusal the recipient cannot act on: the link and
  // the key both still exist, so say what to ask for rather than implying the
  // link itself is dead.
  if (code === "link_disabled")
    return "This share link's API key is paused. Ask whoever shared this link to re-enable it.";
  if (code === "link_expired") return "This share link has expired.";
  if (code === "link_revoked") return "This share link has been revoked.";
  return undefined;
}
