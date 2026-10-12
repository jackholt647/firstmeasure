# Notes GIFs, author filters and advanced audiences — October 12, 2026

Feature commit `18d7c000`, compatibility guard `7097d992`; integrated source is
`8a1250d7334bf6ff0e28569ef78ec30b5999fb9f` for the verified rollout below.

Both the main and reply composers reuse Channels' GIF picker button, staged
preview, removal action and message card. Controls follow the same order:
emoji, GIF, file, dictation, audio. Selection remains a draft until submit;
GIF-only notes/replies are valid, failed sends retain the draft, successful
reply sends close the composer. The main form has no extra background or
separator around its outlined composer.

The Notes toolbar follows Activity's search and filter layout. Filters list
project note authors, support several selections or an Only shortcut, search
authors, and include Show Archived Notes in the footer. The author endpoint
reads complete root-note audience policies without note text and returns only
authors whose notes the viewer can access. Author filtering occurs before
pagination. Its cursor tracks raw pages so hidden private notes cannot truncate
subsequent pages.

Visibility starts with Everybody, then Your Departments using the configured
department terminology. Advanced visibility offers the organization's resource
group types, actual groups and individual active users in eligible departments,
with a search field. The existing field-application audience remains explicitly
labeled under Application access in Advanced; it is separate from group membership.
The standalone word Just is removed.

## Audience contract

The shared workforce resolver retains active resource-group IDs on user
memberships, plus each group's stable kind ID, label and department affiliations.
Notes persist typed resource_group, resource_group_kind and user references.
Group-type references are bounded to the sender's eligible department IDs;
organization-wide administrators can choose the whole type. User/group IDs are
validated within the current organization and department context. Active group
membership is resolved afresh through the ordinary authorization context;
renaming terminology, labels or roles does not alter recipients.

Advanced selections replace broad department selections, preventing a selected
individual from accidentally sharing with everyone in their department. The
root author retains access; existing organizational administrative access remains.
Project/channel authorization remains required. Replies inherit the root policy,
including existing and archived replies after direct visibility or text-edit
updates. Ordinary edits preserve an untouched policy. New reserved metadata is
server-owned and cannot be injected through generic message metadata. Older
composers cannot clear an advanced policy using department-only payloads; the
server requires them to refresh. Existing legacy audiences remain compatible.

Scope sets and project assignments are not inferred as user groups or permission
grants. These choices are current organization memberships, not a snapshot of
which crew happened to be assigned when the note was written. There is no schema
migration or worker change.

## Verification

14 isolated note audience/count/author and organization-structure tests pass,
including membership removal, inherited policy, foreign/unavailable IDs, type
bounds, metadata injection and older-client protection. TypeScript checks pass.
48 existing Channels and department tests pass. Three browser checks pass:
Notes, Channels Enter/Shift+Enter and Feed GIF drafts. Notes additionally verifies
real shared rich formatting, preview widgets, failure retention, GIF-only send,
reply closure, filters and advanced choices at narrow tray widths. Fixture APIs
write no customer notes.

## Development rollout

The rollout overlays only reviewed owned files onto each current immutable
release. Existing Feed access/storage/client differences, scoped Feed exclusions,
per-role application manifests and concurrent editor changes are preserved.
Backends are activated across web, pool and compatibility before publishing the
new frontend. UI activation reloads PHP without restarting the already-verified
backend. Each phase guards the current path/runtime, verifies source/compiled
hashes, and requires development isolation and outbound-safety enforcement.

Payloads, baseline audits, scripts and receipts are retained under ignored
output/notes-gifs-deploy and in immutable releases. Superseded/failed staging
candidates were never activated. Rollback must preserve later work and reverse
only the owned patch. Production is outside this rollout's authorization.

## Verified result

All three development roles passed final source and compiled hashes, readiness,
exact runtime identity and enforced outbound safety. Public Notes, Channels UI,
Channels client and the application manifest matched reviewed payload hashes.
The Notes browser regression passed again using dev-hosted libraries. No customer
notes were posted by these checks.

Runtime identity: `8a1250d7334bf6ff0e28569ef78ec30b5999fb9f`. Bundle version:
`20261012-notes-gifs-audiences-v6`.

| Role | Current release | Backend stage | Previous release |
| --- | --- | --- | --- |
| Web | `/opt/firstmeasure/releases/8a1250d7334bf6ff0e28569ef78ec30b5999fb9f-notes-gifs-ui` | `/opt/firstmeasure/releases/8a1250d7334bf6ff0e28569ef78ec30b5999fb9f-notes-gifs-api` | `/opt/firstmeasure/releases/2cd4c8d27bf0333aacda35553e11526ed95bb114` |
| Pool | `/opt/firstmeasure/releases/8a1250d7334bf6ff0e28569ef78ec30b5999fb9f-notes-gifs-ui` | `/opt/firstmeasure/releases/8a1250d7334bf6ff0e28569ef78ec30b5999fb9f-notes-gifs-api` | `/opt/firstmeasure/releases/2cd4c8d27bf0333aacda35553e11526ed95bb114` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases/8a1250d7334bf6ff0e28569ef78ec30b5999fb9f-notes-gifs-ui` | `/mnt/firstmeasure_dev_releases/releases/8a1250d7334bf6ff0e28569ef78ec30b5999fb9f-notes-gifs-api` | `/mnt/firstmeasure_dev_releases/releases/2cd4c8d27bf0333aacda35553e11526ed95bb114` |

Notes SHA-256:
`942eef775d6fb354433c95b0913c4bf6562195b8bc10bd09c3987ce0fc439d0e`.


## Picker layer follow-up

Frontend commit `e49449c59441c9fce8e9cd99590e9a4fc7db32ca` fixes the shared picker popover's hardcoded layer
1601, which was below the project's modal layer. The picker now measures its
anchor's ancestor layers and opens above them, bounded to the browser's maximum
layer value. This applies to GIF and shared emoji popovers. Channels and widget
loaders use a new picker cache version; the runtime's grouped-widget loader and
Notes/Channels bundle versions are refreshed.

The reply composer removes its REPLY heading and places Close beside Send in
the bottom action row. Closing still preserves the draft. Author filters use the
same outlined search wrapper and magnifying glass as the adjacent toolbar search,
with placeholder Search and accessible label Search note authors. Only remains
the Activity-style shortcut for selecting one author and clearing the others;
its tooltip now explains that behavior.

Three browser checks pass locally and again using development-hosted assets.
The Notes fixture now exercises the real shared picker popover in both main and
reply composers above layer 2147483100, tests hit targets with elementFromPoint,
and selects GIFs through the picker UI. Only the GIPHY SDK/config and delivery
are fixtures. It also verifies the compact reply controls and author search.
The previous Notes check used a picker stub and could not detect this layer bug.
Channels Enter/Shift+Enter and Feed GIF drafts still pass. No customer writes
are made by the checks.

All three roles passed immutable frontend staging, JavaScript syntax, activation,
source hashes, readiness, exact retained backend identity and enforced development
outbound safety. Public hashes for all six owned frontend assets match reviewed
payloads. The frontend rollout reloads PHP only, preserving backend/runtime
`8a1250d7334bf6ff0e28569ef78ec30b5999fb9f`, compiled modules, data and other deployed changes.

| Role | Current frontend release |
| --- | --- |
| Web | `/opt/firstmeasure/releases/e49449c59441c9fce8e9cd99590e9a4fc7db32ca-notes-picker-layer` |
| Pool | `/opt/firstmeasure/releases/e49449c59441c9fce8e9cd99590e9a4fc7db32ca-notes-picker-layer` |
| Compatibility | `/mnt/firstmeasure_dev_releases/releases/e49449c59441c9fce8e9cd99590e9a4fc7db32ca-notes-picker-layer` |

Previous frontend releases are the corresponding `8a1250d7334bf6ff0e28569ef78ec30b5999fb9f-notes-gifs-ui`
paths above. Baselines, owned patches, role manifests, scripts and verification
receipts are retained under ignored output/notes-picker-layer-deploy and in the
immutable release. Production was not changed.

## Author checkbox and composer gap follow-up

Feature c5d3806a, integrated frontend source `d13364c03372d403d92fc603df335a8f2a776195`. Authors start checked;
Only actions are removed. Empty selection shows no notes. Select All checks all
authors, including those hidden by search. All-selection includes new authors on
refresh. Filters stays the toolbar label for every selection. Checkbox focus is
retained on repaint; subsets retain authorized paging and archive behavior.

The transparent composer surround now matches the history background (#fafbfc).
A 24-pixel gap lets the viewport extend 20 pixels below the composer form's top.
The final eight pixels fade, starting halfway through the gap and finishing four
pixels before the editor border. Bottom padding leaves the final note readable
at the end of scrolling.

Notes browser checks passed locally and with dev-hosted assets: checked defaults,
subsets, zero selection, Select All while searching, fixed label, matching
background and fade geometry. All development roles passed source hashes,
readiness, retained runtime identity and enforced outbound safety. Public Notes
and manifest hashes match reviewed payloads. No backend, data or worker change.

Current frontend paths:

- Web/pool: `/opt/firstmeasure/releases/d13364c03372d403d92fc603df335a8f2a776195-notes-author-selection`.
- Compatibility: `/mnt/firstmeasure_dev_releases/releases/d13364c03372d403d92fc603df335a8f2a776195-notes-author-selection`.

Each role preserves the concurrent editor baseline and backend runtime `7b30efb54dc6502d54780601029120b8c979d7e5`.
Prior paths use that ID in the same release directories. Baselines, owned patches,
scripts and receipts are retained under ignored output/notes-author-selection-deploy
and in the immutable releases. Production was not changed.
