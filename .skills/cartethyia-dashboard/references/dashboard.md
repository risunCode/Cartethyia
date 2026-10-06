# Dashboard reference

Procedure detail for the share page, social-metadata injection, and verification
choice. Summary rules live in `../SKILL.md`.

## Share page

Keep share data and token units sourced from one provider. Public recipients may
copy model ids but must not receive admin controls such as probe, enable,
disable, or delete. Treat theme, backdrop, responsive layout, and model grouping
as UI behavior to verify.

## Social metadata injection

One `dashboard/index.html` serves landing, console, and share routes. Crawlers
do not execute the client bundle, so route-specific tags must be injected into
served HTML by `src/console/dashboard-assets.ts`:

1. Use sentinel comments to mark the replaceable region.
2. HTML-escape every injected value.
3. Preserve the shared document; do not branch per route in Vite.
4. Thread the pathname through document serving.
5. Keep CSP hashing based on the **final** body, after injection.

Do not add another Vite HTML entry. Verify the built document and live route
responses, not only the source.
