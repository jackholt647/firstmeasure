# Default materials and labor from a measurement report — development, October 22, 2026

Releases `96b87085d50890818f6ee36fcfc73049e2fda2b4` (all four roles, parent `276ade49`) and the editor follow-up
`2b6d6db137a41f7d576cb5ff0c000295b167a22d` (legacy and web only, parent `4cf68f77`; see the pool below). Both commits were made on the
session branch `claude/report-default-materials-437ad5`, rebased onto `codex/consolidated-firstmeasure-20260923` and
moved onto it with `integrate.py`, so both are on the canonical branch.

**What changed.**
- Settings › Reports has two sub-tabs. **Default materials and labor** (`settings/measurement-defaults.js`) holds
  the organization's defaults: material rules (roof measurements added together, waste, the package it is bought
  in, a price book product by name or item type), a roof waste formula, and the roofing work a job includes. Materials
  and labor switch on and off separately. The editor saves as it is changed. An organization that never saved its own
  has the industry defaults, with both halves on.
- With no signed document, the Materials column's Generate (the wand) calls
  `POST /v1/materials/organizations/:orgId/projects/:projectId/calculus/defaults`. It publishes the defaults as one
  materials ledger set (origin `defaults`) and evaluates and applies it as the `materials.calculus` generator. Work is
  named without amounts, so the scope set sizes it from the measurements.
- A set published by a signed document overrides the defaults completely. Nothing more is generated from them, and
  `projectScopeSets` leaves the defaults set out of the requirements.
- Docs: `docs/architecture/requirements.md` (Publishing a scope) and `project-history.md`.

**Tests.** These pass: `measurement-defaults` (new; covers generating with no document, a document overriding,
labor off, both off, the legacy measurements fallback, revision conflicts), `work-requirements`,
`publication-measurement-schemas`, `labor-pay-sheets` and `project-history` (19 tests), plus `npm run check`.

**Rollout.** `output/measurement-defaults-20261022/` (scripts copied from `forward-cert-20261019`).
- The first `ship.sh` staged every role, but worker activation was refused with "Active release changed": another
  session activated `84b24451` in between. Nothing was activated, so no role was left mixed.
- The rerun merged onto `84b24451`, then staged, activated and verified all four roles (`verify_exit=0`).
- The follow-up (the editor saves as it is changed, picks products by name, fills its placeholders) was meant for
  `legacy web pool`. **The dev pool node `10.124.16.3` stopped answering** (no route from the web node, 15+ minutes
  of retries) after `96b87085` was active on it, so the follow-up went to `legacy web` only.
  - With pool gone, the web node was the only server behind the load balancer. Its activation restart gave
    dev.1m8.ai about one minute of 503s (21:35 to 21:36 local); it recovered by itself.
  - When pool comes back it serves `96b87085`'s editor, which works but shows the old Save button and raw
    product ids. Reship with `ROLES=pool bash output/measurement-defaults-20261022/ship.sh`.
  - `verify` reported exit 2 only because the manifest still listed the worker, which was not staged. Legacy and
    web serve `2b6d6db1`. Manifest:
  `materials/project.js` `20261022-measurement-defaults`, `settings/company.js` `20261022-measurement-defaults-2`.
  `calculus-native.js` and `measurement-defaults.js` carry their own `?v=` keys.

**Data on dev.**
- Industry defaults saved explicitly (revision 1) on:
  - FH Pilot Roofing (test) `org_301b0d762ed917ba`;
  - fulltest `org_b130bbce08069636`;
  - the newest Instant Full Org, Copper Lynx Test Co `org_bd2dc4ec23d4c65f`.
- Every other organization reads the same defaults until it saves its own.
- The FH Pilot and fulltest orgs have Materials (`platform.materials`) off, so their Project tab has no Materials
  column. Their capabilities were not changed.
- Verification project: `project_f9118d9113e16168`, "4725 W Mercer Way (roof report only, defaults test)", in Copper
  Lynx. Its only data is a copy of the FH pilot report's measurement dataset (43.6 sq, steep).

**Verified in a browser** (Playwright, sandbox test login of Copper Lynx):
- Project › Materials wand → 12 lines, $10,673.71 projected, and 9 work requirements.
- Requirements › Fix all assigned Crew 2 and priced its work order from its pay sheet: tear-off and install per
  square, plus a steep adder. Requirements then read "Everything is accounted for".
- Settings › Reports › Default materials and labor loads with price book names. Switching labor off and on saves
  each time, and the value survives a reload. The test org was left with both switches on (revision 5).

**Not built / limits.**
- Pipe boots and other penetrations are not in the measurement dictionary, so they are not generated. Each
  generation warns about it.
- Story count is not measured, so the defaults have no story adder. Pitch adders live on pay sheets.
- The defaults are roofing only.
- There is no publication action for generating from the defaults, only the HTTP route.
