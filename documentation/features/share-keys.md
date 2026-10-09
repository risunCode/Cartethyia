# Share keys

A share link is a public URL that mints a **child API key** under a parent
*share template*. Anyone holding the link can enroll once and get a bearer key
that lives inside the parent's budget, denylist, model allowlist, and CLI
mapping bucket — without the operator handing out the parent secret.

The template is an ordinary `api_keys` row with `key_mode = 'share'`. Its own
counter never moves for child traffic; reporting sums the parent plus every
recipient it has issued, revoked ones included, because that spend is already
spent.

## Data

| Table | Key | Holds |
| --- | --- | --- |
| `share_links` | unique `token_hash` | `token_encrypted`, `kind`, `active`, `expires_at`, `last_viewed_at` |
| `share_popups` | PK `api_key_id` | `enabled`, `image`, `image_mime`, `title`, `body` |
| `api_keys` | `parentKeyId` | The child row itself |

**Token.** Generated at 43 base64url characters; the lookup is on the hash
(`hashShareToken`). The plaintext is kept in `token_encrypted` only so the
console can re-display a stable link. Rows written before that column existed
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

`createShareRouter` is mounted separately by `createShareRouter` in
`src/boot/app.ts:531` — **not** under `/console/api`, because it must work
without a session:

| Route | Purpose |
| --- | --- |
| `GET /share/:token/data` | Policy, popup, and allowed-model catalog for the page |
| `GET /share/:token/popup-image` | The image bytes, served with the API's content-security and frame headers |
| `POST /share/:token/issue` | Mint the child key |
| `GET /share/:token/stats` | Family totals, hourly buckets, top models, top client IPs |
| `GET /share/:token/stats/stream` | The same as SSE, one snapshot every 2 s |

`issue` allows **one child key per canonical client IP** (`canonicalClientIpKey`,
so a NAT'd office still shares a key rather than spraying new ones). The child
bearer is returned only by that call — never by `stats`, never by `data`, never
again.

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

`dashboard/src/apps/share` is the public page. It reads the share API and has
**no** probe, enable, disable, or delete controls — model ids can be copied, and
admin actions stay in the console. The owner's side is
`ShareManagementDialog.tsx` plus the share section of `ApiKeyForm.tsx`.

Social tags for the share route are injected into the served HTML by
`src/console/dashboard-assets.ts`; they are not present in the React tree, so a
check against the bundle proves nothing.

## Where to change what

| Change | Start here |
| --- | --- |
| Token format or hash | `src/persistence/stores/share-store.ts`, `MIN_TOKEN_LENGTH` in `share-router.ts` |
| Enrollment rules (one per IP, refusal reasons) | `src/console/share/share-router.ts` |
| Family usage and stats | `src/console/share/{share-usage,share-stats}.ts` |
| Popup validation | `src/console/api-keys/share-popup-image.ts` |
| Link and popup schema | `src/persistence/schema.ts` (`shareLinks`, `sharePopups`) |
| Public page | `dashboard/src/apps/share` |

## See also

- [`console-api.md`](../console-api.md) — the four boundaries; the public router
  deliberately bypasses the session one.
- [`backend.md`](../backend.md) — where the domain sits in the console mount.
