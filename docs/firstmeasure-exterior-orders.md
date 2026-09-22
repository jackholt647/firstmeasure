# Customer Full House ordering

Local implementation; no dev or production deployment.

## Pilot controls

All organization capabilities default to false:

- `firstmeasure.exteriors`: enables the residential Full House / Just the Roof choice.
- `firstmeasure.exteriors_commercial`: additionally allows commercial ordering.
- `firstmeasure.exteriors_multifamily`: additionally allows multifamily ordering.

These use the existing administrator-managed capability system. Turning the master flag off prevents new exterior quotes, uploads and orders on the server, including submissions from stale pages. Previously purchased reports remain accessible. The temporary Preview Roofing test enablement was reverted to false after verification. Flow Roofing was not enabled.

## Pricing and workflow

Internal Prices includes editable Full House base, same-day and priority amounts. Initial per-structure totals are $25 for 24-hour delivery, $30 for under six hours, and $35 for under three hours. Standard demand estimates and the busy indicator derive from the roof workload calculation. Prices are read from shared storage per request; checkout rejects a stale pricing revision.

Property choices remain compact and changeable after selection, including when the pilot is off. Full House uses Delivery, References and Review pages. Each structure requires eight separate uploaded media records (front, front-right, right, back-right, back, back-left, left, front-left). Additional images and technician notes are optional. Roof measurements and gutters are included without another gutter charge. The existing credit checkout is reused, including automatic submission after funding.

Customer exterior projects use the reserved `exteriors_<32 hex>` namespace. This keeps customer work distinct from private `fullhouse_` drafts. References are copied into the measurement project's artifact storage before making it queued. Staff editors load the existing exterior tools and show customer references read-only. Roof-only delivery upgrades are blocked for exterior orders. Expedited refunds use the stored Full House base amount rather than recomputing a roof price.

## Verification (September 19, 2026)

- TypeScript build and changed JavaScript/PHP syntax checks passed.
- Seven focused tests passed across exterior ordering, staff PHP rendering, internal pricing, checkout-draft recovery, and existing mobile draft behavior.
- Backend checks cover default-off and property-type gates, CSRF, missing/duplicate/invalid references, unavailable media, stale prices, all three price/deadline options, forced free gutters, persisted exterior geometry metadata, copied artifacts, direct queue rejection, and an unchanged $7 roof order.
- Browser checks at desktop, 390px and 320px: delivery/reference/review pages, eight actual file uploads, required-reference gating, compact property choices, commercial/multifamily roof-only behavior, return to the roof workflow, and the disabled pilot after refresh.
- Local fake checkout funded fictional credits and automatically submitted a priority order. Stored record `exteriors_ffba0878666c25522b3fc36c8d8206b3` has a $35 charge, $25 base, three-hour deadline, gutters, eight artifacts and technician notes. No payment provider was connected.

## Dev validation still needed

The isolated preview blocks backend provider traffic and runs without production workers. Real imagery acquisition, technician completion, QA approval, generated exterior PDF quality, delivery email, and production Postgres/Spaces/queue behavior still need a controlled dev rehearsal. Browser viewport checks are not physical-device certification. Nothing was pushed or activated.

## Review pilot enabled

At the user's request, enabled `firstmeasure.exteriors` for local Flow Roofing (`0a8f8865e3c78d2441e08746`). Commercial and multifamily remain off. Opened the existing Arvada draft (`project_mu9bu6mk_cz6iitqa`, 9950 W 80th Ave) at the Full House delivery step without submitting an order. Fixed URL draft hydration to recover the report workflow before rendering controls; the five draft-focused tests pass, including the new regression. This does not change capability defaults or deploy anything.

## Photo workflow usability pass (2026-09-19)

- Replaced the passive diagram and native file-input rows with eight clickable photo positions around a house in a 3x3 grid, oriented to the street at the bottom.
- Added multi-file upload and a photo tray. Selecting a photo then tapping a position assigns it; the next unassigned photo is selected automatically. Replacing a position preserves its previous photo in the tray. Extra references are explicitly assigned rather than silently submitted as required views.
- Photo uploads have thumbnails, completion counts, removal and retry controls, image validation, and at most three concurrent requests. Pending, failed, and unassigned photos block review. Removing a structure returns its photos to the tray.
- Delivery, Photos, and Review are clickable when their prerequisites are met. References, delivery choice, and technician notes survive step navigation.
- Full House requires explicit confirmation of the current pins; changes to pin coordinates or count invalidate confirmation. On phones, Check / edit pins opens the map with a return-to-order button.
- On Photos and Review, repeated address/contact inputs are hidden (the project address stays in the title). Internal notes are hidden during Full House ordering to give the workflow space; technician notes remain available in Photos. Navigation buttons stay at the bottom of the visible workflow.

Validation: 10 focused frontend tests passed (exteriors-photo-workflow, exteriors-order-draft, firstmeasure-mobile-draft), plus JavaScript syntax checks. Local browser checks exercised eight-image bulk upload/assignment, review without submission, backward navigation retaining notes/photos, replacement retaining displaced photos, and the mobile map editor. Layout inspected at desktop 1280x720 and phones 390x844 and 320x740. Test images were labeled fictional fixtures. No customer order was submitted; no deployment or feature-default changes were made.

## Roof / Full House parity pass (2026-09-20)

- Roof Only is first, Full House second, with icons and report details available both by hover/focus and by tapping the information button. The details reuse the existing gutter-report popout/modal, describe walls/siding, windows, doors, roof and gutters, and link to `samples/full_house_sample.pdf`. Per explicit user direction, that PDF is intentionally absent (404) until supplied.
- Full House mounts the actual existing roof pin count, Clear All, confirmation, technician notes and CC controls. It restores them to their original positions when switching to Roof Only. Pins come first and confirmation unlocks the same notes/CC section followed by delivery. No duplicate CC or technician-notes state.
- Delivery now uses the roof card and workload-meter styling. Inclusions live in the information panel rather than under Standard delivery. Shared closed-hours messaging applies, expediting is disabled while closed, and server validation also rejects closed-hours expedited orders (including zero-priced expedited options).
- Unfinished report drafts keep property-type choices after refresh. Ordered projects retain their existing behavior.
- `firstmeasure.exteriors_photo_review_test` defaults false and requires the Full House flag. The quote endpoint only allows it outside production; enabled only for local Flow review org `0a8f8865e3c78d2441e08746`. It permits reaching Review without photos but never allows an incomplete order to submit. Production and queue validation remain enforced.

Validation: 13 focused frontend tests plus the backend exterior-order integration test, including default-off/test-org/production guard, missing-photo rejection, closed-hours behavior and zero-fee expedited rejection. TypeScript check passes. Browser verification covers refresh on desktop/mobile, shared notes and CC retained across report-type changes, mobile pin editing, report info modal, and no-photo review with ordering disabled. No orders submitted through the review portal and no deployment.
