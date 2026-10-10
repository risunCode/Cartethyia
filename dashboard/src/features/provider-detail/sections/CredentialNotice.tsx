import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardBody } from "../../../components/ui/card";
import { Inline } from "../../../components/ui/inline";
import type { ProviderResponse } from "../../../data/contracts";

/**
 * Where an operator obtains this provider's credential.
 *
 * The link and the guidance come from the provider's bundled metadata, so a new
 * provider gets the notice by declaring `credentialUrl` / `credentialHint`
 * beside its identity rather than by touching the dashboard. Rendered only when
 * there is something to show: a provider with no published page would otherwise
 * get an empty card that implies one exists.
 */
export function CredentialNotice({
  provider,
}: {
  readonly provider: ProviderResponse;
}): ReactNode {
  const url = provider.credentialUrl;
  const hint = provider.credentialHint;
  const notice = provider.operatorNotice;
  if (!url && !hint && !notice) return null;

  // A provider that authorizes through its own login flow has no key to paste,
  // so the action is labelled for what it actually does. The login buttons
  // themselves live on the Accounts card.
  const usesLogin = provider.oauthFlows?.browser === true || provider.oauthFlows?.device === true;
  const guidance =
    hint ??
    (usesLogin
      ? "This provider authorizes through its own login flow; there is no key to paste."
      : provider.requiresAccount
        ? "Create a credential on the provider site, then add it as an account below."
        : "This provider needs no credential.");

  return (
    <Card density="compact">
      <CardBody>
        <Inline gap="12px" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: "var(--text-secondary)" }}>
            {guidance}
            {notice ? <><br />{notice}</> : null}
          </span>
          {url ? (
            // A real anchor rather than a button with a click handler: the
            // external page opens without a popup blocker, and middle-click,
            // keyboard activation, and "open in new tab" all keep working.
            <a
              className="btn btn-secondary btn-sm"
              href={url}
              target="_blank"
              rel="noreferrer"
              title={url}
              style={{ flexShrink: 0, textDecoration: "none" }}
            >
              <span className="btn-icon-wrapper" aria-hidden="true">
                <ExternalLink size={13} />
              </span>
              {usesLogin ? "Sign in" : "Get API Key"}
            </a>
          ) : null}
        </Inline>
      </CardBody>
    </Card>
  );
}
