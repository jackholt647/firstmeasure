# Synchronized project details and consistent styling — development, October 2

Source release: `c908b539625e3a2578b835995d176ae5877c1176`.

Overview keeps its contact, address and custom-field controls mounted when the header
dropdown opens. A separate view reconciles values and structure with unique IDs; edits
route through the original handlers, preserving domain saves, contact actions and map
address selection. Closing the dropdown disconnects its observers and listeners.

Overview removes the extra nested scrollbar padding and duplicate margin above the
address divider. Initial actions occupy two equal grid columns and include icons.
Header pills have more separation and the preload uses the same rounding, typography,
padding and colors as the loaded header.

The Notes tray keeps its full-height history and existing Channels model. The composer
uses the previous ADD NOTE / Who can see it? layout, rounded textarea, bordered attachment
and audio controls, and joined Note / Pin buttons. Visibility remains editable; drafts,
attachments, edit history, replies and pin behavior remain on the existing model.

Validation: 23 focused checks passed across project opening, identity synchronization,
contact shortcuts, workflow, trays, and preload/loaded computed-style comparisons.
Three frontend assets are deployed; no backend source changes or worker activation.

The New Report heading and hidden tabs apply only before project identity is defined.
Existing-project opening never infers the report workflow from an unfinished draft.
Explicit report ordering for an existing project keeps its normal title and tabs.
Selecting a project or defining a new address restores normal chrome with a short
identity slide and staggered tab reveal; reduced-motion preferences are respected.

The first rollout deployed the shared details and notes changes as `74605b592745bec626d5d8d99354e37e02aa0aa9`.
The final release additionally fixes inner property-pill dimensions, narrow phone-field
overflow, equal-height action tiles, and the New Report header scope.

All three development roles activated the final release and passed readiness and
isolation checks. Public hashes match all three affected frontend assets. The final
rollback baselines are web/pool `8b2c81652c5c301006ee58bb1bbebb89805aab9a` and legacy
`74605b592745bec626d5d8d99354e37e02aa0aa9`; role-specific code was preserved by three-way merge.
No production changes were made.

Live sandbox verification confirmed:
- Editing a synthetic contact in the dropdown updates Overview immediately; the test
  name was restored. Original controls stay mounted in the Overview column.
- A narrow column has clientWidth = scrollWidth = 229px; all three action tiles measure
  110.25 by 72.375px. The contact row no longer forces horizontal scrolling.
- Notes shows the prior composer design with full-height history.
- New Report starts with the temporary title. Selecting the saved project restores its
  normal identity and visible tabs. Reopening it via normal project search also retains
  normal chrome. No browser errors were observed during the transition.
No reports, calls, messages, or notes were submitted during verification.

Local evidence: `output/project-report-header-scope-20261002/verified-project.png`,
`manifest.json` and `public-assets.json`.
