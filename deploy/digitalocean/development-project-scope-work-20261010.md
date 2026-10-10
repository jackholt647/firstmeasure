# Project scope of work — development rollout, October 10, 2026

Feature commits: `329e2565dcc417b61b38a386973367aabd1917b0` (initial workspace),
`8274439e6a9e08b656e88de7a2b9eedcdfdde5df` (thumbnail fallback),
`3147d0d50f66d4bd35a1b526b831d9d0f51dd283` (published artifact rail),
`43bff1e90b24d341724025111a798f1517309f9c` (completed-report compatibility), and
`fa8c5394e6d0059810de44a88e4e0b27a23ee7dd` (complete static preview runtime) on
`codex/consolidated-firstmeasure-20260923`. The user authorized implementation,
GitHub publication and deployment to `https://dev.1m8.ai`.

## Behavior

The existing `scope.project_tab` terminology key defaults to Project in the
terminology catalog, backend contract, browser resolver and installed language
packs. Organization terminology overrides retain their usual precedence.
Internal scope identifiers and domain contracts are unchanged.

The private left rail has Scope of Work, 3D Roof and Aerial View as three compact
icon tabs against its bottom edge. Scope of Work shows accepted document
publishers above published measurement datasets. Drafts and standalone
presentations are excluded: document cards require persisted material ledger
origins identifying an accepted snapshot and a signed/completed document.
Accepted materialized module documents use the same evidence. Measurement
reads use the typed dataset publication provider, with historical revision pins.
Older completed reports remain visible through existing authorized read-only
project-widget contracts; opening does not create/import datasets.

Tiles show retained contract totals when available, published material counts
and measurement quantities with units. Hover/focus previews show content.
Opening replaces the left rail with readable quantities, costs and source
artifacts plus the accepted snapshot rendered by FMDocRenderer; Back restores
the tiles. There is no modal or generic JSON viewer. Resource list commands
remain in a compact disclosure. The right-side heading/toolbar/footer are
removed; Materials, Labor and Equipment use the full available height, with the
Price Book control in the Materials heading.

Resource panes remain visible together and scroll independently. Empty panes
narrow when another pane has items; three empty panes share the width equally
and display Empty List. Each pane has an Add button. Its first use creates the
missing typed list through the existing writer and adds an editable row; later
adds reuse that list. Creation failures do not submit an item. The new row's
name receives focus, and other panes retain their scroll positions.

Project widgets start at one third of the workspace and content at two thirds.
The app owns a draggable, keyboard accessible divider and locally remembers the
chosen proportion. Mobile retains stacked widgets/content and hides the divider.
The right-side refresh button is removed. Background reads refresh changed
records every twenty seconds while the app is visible and idle. They skip
focused edits, dialogs and writes. Opening/refreshing never regenerates material
quantities; explicit generation, scheduling and ordering remain resource-list commands.

## Validation

- Isolated feature source passed TypeScript checking.
- Thirteen scope/resource behavior and browser checks passed: accepted publisher filtering, exclusion of drafts/presentations, captured totals,
  in-rail details/back, rendered accepted snapshots, compact tabs, unavailable reads,
  first-add creation and reuse for all three resource types,
  failure handling, equal/narrow columns, independent scrolling, dragging,
  keyboard controls, mobile layout, completed legacy-report compatibility and
  existing read-only scope loading.
- Six terminology contract/browser checks and nine terminology integration
  checks passed against isolated feature source.
- Fifteen existing materials lifecycle/calculus tests passed, including real
  ledger/browser interaction, signed deliverables, amendments, ordering,
  deliveries, revision races and authorization.
- Desktop/mobile development browser checks with the isolated feature assets
  passed without browser errors. The read-only hosted project fixture has
  materials and no published scope sources; source-card selection/rendering is covered
  by dedicated source fixtures. A read-only browser fixture additionally passed
  against the real FMDocModel/FMDocRenderer libraries: contract total, material
  quantities/costs, rendered accepted text and line-item widgets, Back and mobile
  layout. Preview initialization loads FMDocModel, FMDocWidgets and FMDocRenderer
  and passes only retained snapshot parameters/outputs to static widgets. No fixture
  document or dataset was persisted.

## Deployment

Each role uses an immutable overlay of its freshly audited running release.
Owned files are detached before writing in hardlink staging. Role-specific
source differences and unrelated local/staged changes are preserved. The initial frontend
rollout received ten files; each follow-up replaced only the material app/helper
and cache-version manifest. The worker receives only the source/compiled terminology
JSON default in the initial rollout. No schema or dependency changes are required.

The web, compatibility and pool roles were activated and independently verified
at `fa8c5394e6d0059810de44a88e4e0b27a23ee7dd`: current symlink, runtime release
identity, owned-file hashes, readiness, development session/environment and
outbound safety. The worker was independently verified at the initial
terminology release `329e2565dcc417b61b38a386973367aabd1917b0`.

The public development site passed desktop/mobile browser checks without page
errors, including all three bottom views, the one-third default rail, resizing,
full-height resource panes and mobile overflow. The retained static preview
fixture also passed against the deployed assets with real line-item widgets.
No production release was activated.

Operational manifests, source hashes, browser screenshots and verification
results are retained in ignored `output/project-scope-work-20261010/`,
`output/project-published-scope-20261010/`, and
`output/project-published-scope-reports-20261010/`, and
`output/project-published-scope-preview-20261010/`.

## Rollback

For the final preview follow-up, the immediate previous frontend release is
`43bff1e90b24d341724025111a798f1517309f9c`:

| Role | Immediate previous path |
| --- | --- |
| web | `/opt/firstmeasure/releases/43bff1e90b24d341724025111a798f1517309f9c` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/43bff1e90b24d341724025111a798f1517309f9c` |
| pool | `/opt/firstmeasure/releases/43bff1e90b24d341724025111a798f1517309f9c` |

The older paths below are the baselines before the entire Project workspace change.

Check for subsequent releases first. Restore the appropriate previous current
symlink, restart only that development service, reload PHP-FPM on frontend roles,
and verify readiness and development isolation.

| Role | Previous path |
| --- | --- |
| web | `/opt/firstmeasure/releases/a693d545e823eef80b2fdf528eabab1a4ff850e5` |
| worker | `/opt/firstmeasure/releases/49309ae1f2a6d25b506161bf81bc64525fc6241c` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/a693d545e823eef80b2fdf528eabab1a4ff850e5` |
| pool | `/opt/firstmeasure/releases/a693d545e823eef80b2fdf528eabab1a4ff850e5` |

Manually added lists/items remain compatible with the previous resource writers.
Divider preferences are local browser settings. Production activation was not
part of this rollout.
