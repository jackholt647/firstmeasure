# Assistant widget view and voice cues — October 2, 2026

Source/release: `dddac94c99755f79d674dff274c3a5cfca85a6d1`.
Development target: `https://dev.1m8.ai`, web/pool only.

## Behavior

Platform widgets use the full-view artifact panel by default, with a persistent
left/right switch. The composer stays centered below both columns. Close widget
view switches to inline artifacts, as do narrow layouts. Natural content height
is retained; long inline widgets have a clipped preview and an explicit expansion
control instead of an internal scrollbar. Fill widgets use the panel height or a
large inline viewport. Voice task widgets remain visible despite hidden backend
transcript wrappers. Side mounts are disposed before inline replacements.

Voice mode has quiet synthesized start, connecting, connected and hang-up cues.
The connecting pulse stops when ready or cancelled; capture stops immediately,
and the audio context closes after the 500ms hang-up tail. No audio assets or
provider configuration changed.

## Verification

Eleven focused browser/runtime checks passed: assistant widgets, voice, project
assistant, shared widget lifecycle/Scope, channel assistant and payment browser. Coverage includes both sides,
centered composer, closed-panel and narrow fallback, long-content expansion,
no horizontal overflow, rapid voice turns, connecting-pulse cancellation and
start/connected/end frequencies. Side and inline screenshots were reviewed.

## Deployment

Activated and verified on both development web roles. Only the assistant and
widget runtime JavaScript were overlaid.
Both roles were staged against `c908b539625e3a2578b835995d176ae5877c1176`;
existing unrelated work is retained. Evidence/manifests are under ignored
`output/assistant-widget-view-20261002/`.

Rollback restores the manifest's prior role release path, restarts the web service,
reloads PHP and verifies development readiness/outbound isolation. Review any
subsequent release before restoring an older baseline.

Both roles passed release, file hashes, readiness and outbound-safety checks.
Public readiness reported the release and both served frontend hashes matched
the manifest. Voice, shared project assistant and widget-view browser checks
passed again using public development assets. Voice endpoints still reject
unauthenticated requests with 401.
