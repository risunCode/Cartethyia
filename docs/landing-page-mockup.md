# Cartethyia Public Landing Mockup

## Approved direction

The public root page (`/`) is a dark, regal gateway for Cartethyia. The composition uses a midnight navy base, aqua wind/tide accents, ivory type, and restrained gold heraldic details.

- Brand: **By Cartethyia / Fleurdelis**
- Primary action: enter the authenticated console at `/console/`
- Secondary story: providers are houses, models are sworn knights, routes are governed from one court
- Type pairing: **Cinzel** for royal display titles, **Cormorant Garamond** for lore copy, **Manrope** for navigation and controls
- Responsive behavior: full-bleed hero on desktop, compact navigation and stacked story cards on mobile

## Current visual assets

The mockup caches the following source images under `src/console/landing-assets/` and serves them locally at `/landing-assets/*`:

- `cartethyia-profile-header.jpg` — hero poster and gallery artwork
- `fleurdelys-official.jpg` — portrait gallery artwork
- `cartethyia-official-sword.jpg` — secondary gallery artwork
- `../dashboard/public/CartethyiaPi/echoborn-cartethyia-awakens.1920x1080.mp4` — fixed full-page background video that stays behind content while scrolling
- `../dashboard/public/CartethyiaPi/kepitsusu.jpg` — authenticated console login backdrop

Character artwork is attributed in the page footer to Kuro Games. The visual sources are linked from the official Wuthering Waves X posts where available.

## Implemented interaction pass

The approved mockup now includes:

1. A welcome gate with staggered crest, title, subtitle, and enter-button animation.
2. An optional `Do not show again for 12 hours` checkbox backed by local storage.
3. A smooth transition that reveals the hero copy when the kingdom is entered.
4. Scroll-triggered reveal choreography for story, feature, gallery, and pricing sections.
5. A floating back-to-top control with smooth return-to-top behavior.
6. A lighter mobile layout and reduced-motion fallback.
7. A public feature showcase covering routing, account rotation, Model Studio, and observability.
8. A Community plan priced at **Free**, with the console as the primary CTA.
9. A direct GitHub link to `risuncode/cartethyia`.
10. A three-image credited gallery instead of a second video card.
11. The supplied Cartethyia MP4 as the fixed full-page background.
12. The supplied Kepitsusu image as the login backdrop, credited to the provided X post.
13. A live marquee status ticker replaces duplicate top navigation links; the console remains the single primary nav button.
14. The login card uses the Cartethyia sidebar GIF, a more transparent glass treatment, inline password visibility control, and a link back to the public page.
15. Login 401 responses preserve `wrong password` instead of being mislabeled as `session expired`.

## References

- Official Wuthering Waves website: <https://wutheringwaves.kurogames.com/main>
- Official Wuthering Waves X account: <https://x.com/Wuthering_Waves>
- Login artwork source: <https://x.com/RaaiVault/status/1934536437464281414?s=20>
- Fleurdelys official post: <https://x.com/Wuthering_Waves/status/1904714927438520656>
- Cartethyia sword artwork post: <https://x.com/Wuthering_Waves/status/1937360031579771242>
- Cinzel: <https://fonts.google.com/specimen/Cinzel>
- Cormorant Garamond: <https://fonts.google.com/specimen/Cormorant+Garamond>
- Repository: <https://github.com/risuncode/cartethyia>
