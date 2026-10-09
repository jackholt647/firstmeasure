# Inherited widget types — October 9, 2026

Feature commit: `8adfbaed6b8caf9aa4acb3f14ae9a8e14deb6de3`.
Release candidate: `80ffae0533ce180f92b205a3acda2142d951738d`.

The shared browser/server widget type graph separates semantic inheritance from
visual composition. Summary and data-entry roots support arbitrary subtype depth,
inherited constraints, schemas, compatible implementation fallback and explicit
ambiguity. Existing exact widget references remain supported.

The release adds project/contact/user/document summaries, document subtype
selection, the editable custom-field vocabulary, and capture/insertion inputs.
The Feed's project links use the generic authorized summary hover host. Shared
Channels emoji, GIF and hyperlink controls are reused by widget adapters. Audio
and dictation use AudioNotes; camera/screen capture owns permission and stream
cleanup. Upload/capture selections contain media IDs. Secure input uses the
existing encrypted Connections credential store and principal-bound requests,
with only a protected reference and saved receipt in history. No plaintext secret
is sent to the model, widget selection transport or serialized widget state.

Validation of the isolated task-only source:

- TypeScript passes locally. The first Linux staging check caught a strict typing
  issue in the new test fixture; the corrected release candidate includes its fix.
- Publication: 69 pass, one PostgreSQL-only skip.
- Integrations/audio: 25 pass, including credential encryption, user/request/
  destination binding and the shared assistant's protected widget presentation.
- Five browser tests pass: summary/input widgets, secure receipts, capture
  cleanup after delayed permission, existing pickers and Connections settings.
- Six Channels UI contract failures reproduce unchanged against the untouched
  baseline. The other thirteen contract checks pass. These inherited failures
  concern old conversation/sidebar/realtime/notes assertions.

Development rollout completed on October 9, 2026. All four roles run
`80ffae0533ce180f92b205a3acda2142d951738d`; readiness, data/cookie isolation
and outbound safeguards pass. Twelve publicly served library assets match the
reviewed hashes, and all five browser checks pass using those hosted scripts.
The four new widget contract tests also pass on the staged Linux web release.
Production activation is not authorized.

Each role receives only the reviewed task delta over its own immutable current
release. Three-way reconciliation preserves unrelated local/staged work and
already-deployed development changes. Source and compiled hashes, Linux checks,
effective development cookie/data isolation and outbound safeguards are checked.
Evidence is in `output/widget-types-20261009/`.

## Role reconciliation and rollback

- web: previous `/opt/firstmeasure/releases/ac8953cf0525d85386240c68c6cd347bcd383ea4`; active `/opt/firstmeasure/releases/80ffae0533ce180f92b205a3acda2142d951738d`; 38 reviewed source/compiled files.
- worker: previous `/opt/firstmeasure/releases/f99e06caad15894bb3764cbd13370bbe43d41361`; active `/opt/firstmeasure/releases/80ffae0533ce180f92b205a3acda2142d951738d`; 30 reviewed source/compiled files.
- legacy: previous `/opt/firstmeasure/releases-root-archive/ac8953cf0525d85386240c68c6cd347bcd383ea4`; active `/opt/firstmeasure/releases-root-archive/80ffae0533ce180f92b205a3acda2142d951738d`; 38 reviewed source/compiled files.
- pool: previous `/opt/firstmeasure/releases/ac8953cf0525d85386240c68c6cd347bcd383ea4`; active `/opt/firstmeasure/releases/80ffae0533ce180f92b205a3acda2142d951738d`; 38 reviewed source/compiled files.

The worker keeps its existing HTTP assistant API: it has no displayed-widget
UI-context endpoint, and copying the newer canonical HTTP module would introduce
an unavailable voice dependency. Its catalog, resolver, adapters and agent tools
receive the widget delta. Serving roles preserve their own assistant API and add
only the optional semantic type on displayed widget references.

The first staging attempts stopped before activation on the strict fixture type
and worker HTTP dependency checks; both were corrected before the successful
rollout. Prior immutable releases remain available at the paths above.

Verification evidence: `stage3.log`, `linux-widget-contracts.log`, `activate.log`,
`verification.json`, `hosted-verify.log`, and `hosted-browser.log` in
`output/widget-types-20261009/`.
