# Share keys

A share link is a public URL for one of two flows. An **enrollment link** under
a parent *share template* lets a recipient mint a **child API key** inside the
parent's budget, denylist, model allowlist, and CLI mapping bucket — without
the operator handing out the template secret. A **handoff link** for a personal
key reveals that existing key to anyone holding the link.

The template is an ordinary top-level `api_keys` row with `key_mode = 'share'`.
Its own counter never moves for child traffic; family reporting sums the parent
plus every recipient it has issued, revoked ones included, because that spend
is already spent. A personal key uses a handoff link instead and has no child
issuance flow.

## Data

| Table | Key | Holds |
| --- | --- | --- |
| `share_links` | unique `token_hash` | `token_encrypted`, `kind`, `active`, `expires_at`, `last_viewed_at` |
| `share_popups` | PK `api_key_id` | `enabled`, `image`, `image_mime`, `title`, `body` |
| `api_keys` | `parentKeyId` | The child row itself |

**Token.** A 32-byte random token encodes to 43 base64url characters; lookup
uses its SHA-256 hash (`hashShareToken`). The plaintext is kept in
`token_encrypted` only so the console can re-display a stable link. Rows written
before that column existed
carry `NULL` and simply cannot be shown again — the remedy is a new link, not a
recovery path. `kind` is `enroll` or `handoff`.

**Popup.** An optional image and text shown on the public page. The image must
be one of four raster formats and at most 2 MiB; the check is a database
constraint (`share_popups_image_mime_check`, `share_popups_image_size_check`) as
well as `parseSharePopupImage` at the boundary, so an oversized or mislabelled
upload is rejected before it is stored.

**The auth read does not load image bytes.** The popup is attached after the
key read, or by a left join on the public share path. Loading it inline would
make every `/v1` request drag a 2 MiB blob through it.

## The public surface

`createShareRouter` is mounted by `createGatewayApp` in `src/boot/app.ts` —
**not** under `/console/api`, because it must work without a session:

| Route | Purpose |
| --- | --- |
| `GET /share/:token/data` | Policy, popup, and allowed-model catalog; enrollment links also report issuance eligibility, while handoff links return the existing key |
| `GET /share/:token/popup-image` | The image bytes, served with a private cache policy and `X-Content-Type-Options: nosniff` |
| `POST /share/:token/issue` | Mint an enrollment child key; requires a non-empty `nameHint` |
| `GET /share/:token/stats` | Family totals, hourly buckets, top models, top client IPs |
| `GET /share/:token/stats/stream` | The same as SSE, one snapshot every 2 s |

Enrollment allows **one active child key per canonical client IP across share
templates** (`canonicalClientIpKey`), so a NAT'd office shares a key rather than
issuing one per link. The newly minted bearer is returned by the successful
`issue` response, not by stats or enrollment data. The share page saves that
enrollment key in IndexedDB in the same browser, keyed by link token, so it can
redisplay a local copy; it deletes that copy if the link lookup fails. A
handoff link is different: its `data` response reveals the existing personal
key whenever the link resolves, and the browser does not persist that key.

## Inheritance

A child authenticates under its own id and reads the parent's policy at auth
time, so an edit on the parent takes effect without rewriting child rows:

- **CLI mapping bucket** — `cliMappingOwnerId` falls back to the parent, so a
  child consumes the parent's remote routes
  ([details](cli-model-mapping.md)).
- **Denylist, allowlist, budgets** — `invalidateApiKeyCache` runs for the parent
  *and every child* after a parent edit. Without that loop a denylist or budget
  edit looks like a no-op for up to `AUTH_CACHE_TTL_MS` per child.
- **Revocation** — flipping a key from `share` to `personal` revokes every live
  child and deactivates every share link in the same transaction.

A child row cannot be edited on its own: `updateKey` refuses with 409
`shared_key_managed_by_parent`. Edit or revoke it through the parent.

## Dashboard

`dashboard/src/apps/share` is the public page. Recipients can copy model ids
and test an allowed model using the shared API key; they have no key-management
controls such as enable, disable, or delete. The owner's side is
`ShareManagementDialog.tsx` plus the share section of `ApiKeyForm.tsx`.

Social tags for the share route are injected into the served HTML by
`src/console/dashboard-assets.ts`; they are not present in the React tree, so a
check against the bundle proves nothing.

## Where to change what

| Change | Start here |
| --- | --- |
| Token format or hash | `src/console/api-keys/routes.ts`, `hashShareToken` in `src/persistence/stores/share-store.ts`, and `MIN_TOKEN_LENGTH` in `src/console/share/share-router.ts` |
| Enrollment rules (one per IP, refusal reasons) | `src/console/share/share-router.ts` |
| Family usage and stats | `src/console/share/{share-usage,share-stats}.ts` |
| Popup validation | `src/console/api-keys/share-popup-image.ts` |
| Link and popup schema | `src/persistence/schema.ts` (`shareLinks`, `sharePopups`) |
| Public page | `dashboard/src/apps/share` |

## See also

- [`console-api.md`](../reference/console-api.md) — console access and mutation
  boundaries; the public router is mounted separately and does not use console
  session authentication.
- [`backend.md`](../reference/backend.md) — backend composition and route mounting.
