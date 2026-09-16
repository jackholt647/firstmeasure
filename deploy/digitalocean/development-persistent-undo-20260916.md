# Persistent roof and wall undo — development only

Release `13a21682c9ae26a53a7e0f4569a28230ffd5c31a` follows development release
`0ea9e7a9cd6d034120e53b8fbe8aaf7ead210031`.

## Behavior and storage

- Roof and wall history no longer discard entries at the old count limits.
- Save stores both undo and redo stacks, their current positions, and wall
  selection history. Reload restores them for the same project. The existing
  option to skip selection-only entries remains effective.
- Roof undo/redo use the same complete snapshot, including manual faces, holes,
  vents, locked planes, and selection. Snapshots retain imagery calibration so
  their points can be restored after changing the raster or structure view.
- Wall generation itself can be undone, including the first generation.
- Equal immutable branches are shared in memory. The saved format deduplicates
  repeated objects, then compresses and divides the result into 1 MiB artifacts.
  There is no history-count or total-history-size cutoff in this implementation.
- `app_metadata.editorHistory` is a versioned manifest of content-addressed
  `editor-history-<sha256>.bin` artifacts. Every part is verified on load. Model
  metadata and history are captured together; metadata is saved only after all
  parts upload. An upload failure leaves the prior saved manifest intact.
- Old projects without a history manifest load normally. Already discarded
  history cannot be recovered. Save is the persistence boundary: this does not
  add per-action server autosave. If a newer wall backup exists locally, its
  difference from the server becomes one recovery checkpoint above saved history.

The format is implemented in `editor_history.js` and loaded for both the standard
roof editor and experimental full-house editor. Node code and backend schemas
are unchanged. Artifact access uses the existing project artifact routes.

## Validation and package

All 790 local editor tests passed. Linux passed 52 focused history/wall tests,
three full-house PHP/access tests, and PHP lint for `editor.php`. Tests cover
history beyond both old limits, saved undo/redo positions, selection restoration
and skipping, branching after undo, first-generation undo, structural sharing,
large multi-part uploads, corrupted downloads, failed uploads, concurrent edits
during save, and switching projects during an upload.

Build checkout: `/home/dev/code/internal-exteriors-build-13a2168` on the dev worker.
Artifact: `/home/dev/exteriors-13a2168.tar.gz`, with companion `.tar.json`.
Size: 249,926,015 bytes. SHA256:
`2b962b1def88b9bc6506ab3723fb960be7d9bbd5c7df2dfc46f3874e980b50ea`.
The verified Linux Node build and production dependencies were reused because
their source/manifests did not change.

Guarded helper: `/home/dev/deploy-history.py` on the worker and
`/tmp/deploy-history.py` on web/compatibility. Its expected baseline is `0ea9e7a`.
Development isolation, exact owner allowlist, outbound safety, readiness,
quiet-worker, and automatic rollback checks are retained.

## Rollout verification

The first candidate, `086927d`, was rolled back on all three development roles
after the live test exposed shared empty-array aliasing: a mutable redo queue
could share a decoded array with an older snapshot's empty geometry. No customer
project was edited during the test. `13a2168` freezes decoded snapshot nodes and
detaches all mutable queue containers/entries and restored selection/trim data.
Two regression tests reproduce the empty-geometry aliasing case for roof and wall
history. The saved test-project artifact itself was valid and remains readable.

All three development roles staged and activated `13a2168`, then passed fresh
runtime checks. Staging verified 1,332 unchanged public source files on each
host. The worker was quiet at activation. PHP FPM restarted with compatibility.
Public readiness reports this exact release and enforced development outbound
isolation. All four changed JavaScript assets served through `dev.1m8.ai` match
Git. Unauthenticated full-house entry remains 404 and the private editor redirects
to login. The existing enable flag and exact `jack@1m8.ai` allowlist are unchanged.

Live browser validation used only the synthetic development project
`fullhouse_246e192b64b4198227dbf3e9ffc58216`:

- Created and saved one roof point, refreshed, undid to zero points, and redid to
  one. Saved at zero points with redo available, refreshed, and redid successfully.
- Created an explicit flat test roof and generated its base. Saved, refreshed,
  and used the wall Undo button to return from one base face to no building.
  Redo restored it. Saved after Undo, refreshed, and Redo again restored it.
- Server artifact reads verified the actual persisted roof/wall undo and redo
  counts and checksums. The test ended back in roof mode with the original empty
  geometry saved, retaining the redo histories. User project geometry was not
  edited, and the user's original tab was not reloaded.
- The corrected release produced no new circular-history error. The synthetic
  project's existing missing-imagery/provider notices and empty-report warning
  were unrelated to history saving.

After the release build, the wall fixture was also configured to enable
`EditorHistory.share` in all wall tests; all 790 editor tests still passed.
This is a test-only follow-up and does not alter the deployed runtime.

Production, provider/signing configuration, and access policies are unchanged.
The prior stable development release `0ea9e7a` remains installed for rollback;
use the guarded procedure in `development-exterior-editor-20260916.md` with
the current release as the expected baseline and `0ea9e7a` as the target.
Do not use the rejected `086927d` candidate as a rollback target.
