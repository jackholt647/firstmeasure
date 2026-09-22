# Project tab promos

Materials pilot: `firstmeasure.materials_promo` (boolean, default false). Operator-facing label: **Materials Coming Soon Promo**. It does not require or grant expanded platform access. Use the existing authorized operator capability controls to enable it for selected organizations; ordinary organization owners do not gain flag administration.

When the effective `platform.materials` capability is enabled, real Scope/Materials takes precedence and the promo is hidden even if its flag remains on. The promo has no material service calls, list generation, order submissions, email sends, or mutation controls. Reports remains first; adding a promo does not split FirstMeasure's inline map into a separate tab.

## Local review

The promo is enabled for local Flow Roofing (`flow-review@example.test`) and fictional Preview Roofing (`preview-owner@example.test`). Other organizations retain the default-off behavior. Flow Roofing retains FirstMeasure-only access; the promo does not enable Scope. Open a project, then **Materials · Coming soon**. No dev or production deployment.

## Reuse

`public/libraries/apps/tab-promos/project.js` exposes `FirstMateTabPromos.register(definition)`. A definition supplies a unique id, shared tabId, title/icon/order, opt-in flag, replacesCapability, optional realEnabled(context) predicate, and content (headlines, product imagery, custom-rules section, feature cards, footer title). Register a corresponding default-false feature in `public/v1/platform/capability_defs.ts` and load the definition in the portal. Definitions must be trusted source code; they are not customer-supplied HTML.

Each promo is a normal `project_modal_app` with an explicit capability gate. It shares the target tab's route ID, but has its own runtime app ID. The existing shared tab renderer renders escaped badge text, including it in the accessible button name. `promoBadge` also identifies promotional apps when preserving the inline-map layout. Duplicate definitions are rejected. Content and image metadata are HTML-escaped. Images are bundled PNG captures of the real development app, using fictional demo project data and the demo catalog. No customer project data appears in the marketing images.

## Creative direction

Brand reference: https://1m8.ai/ (reviewed 2026-09-19). FirstMate red/charcoal/white, direct benefit-led copy, materials-first focus. Headline: **Your products. Your rules. Your material lists.** The promo markets the Materials workflow within the actual Scope app. Two full-width screenshots show Scope with a populated roof material list and its real Price Book variant editor. Captured locally on 2026-09-19 using fictional Preview Roofing, project 456 Test Avenue; sample quantities and prices are illustrative data, while all UI is the actual app. These replace the earlier SVG mockups.

## Validation

- TypeScript build, modified JavaScript syntax checks, PHP lint and diff whitespace check passed.
- Six focused tests passed: default-off, admin restrictions, strict opt-in without expanded access, real-app precedence, no mutation controls/revocation cleanup, and reuse/duplicate registration.
- Browser review: actual opt-in tab, both SVGs loaded, switching Reports/Materials, desktop content/footer; 320px and 390px phone widths and 844x390 landscape with zero horizontal overflow. Landscape modal/close controls stay within viewport after resize settles.
- Browser viewport was restored. No claims of physical-phone certification.

## Actual Scope screenshot revision (2026-09-19)
- Replaced mockups with local screenshots of the actual Scope material list and its full Price Book variant editor. Demo list quantities and measurements were seeded only in fictional Preview Roofing; no real customer data is in the marketing images.
- Screenshots occupy full-width sections and open at full size when clicked.
- Enabled only the promo capability for local Flow Roofing review. Temporary Scope/Price Book access for fictional Preview Roofing was restored to off after capture.
- Verified Flow review shows Reports and Materials Coming soon (no actual Scope access), both PNG assets load, and 390px/320px layouts have no document horizontal overflow. Four promo tests and JavaScript syntax checks pass. No deployment.
