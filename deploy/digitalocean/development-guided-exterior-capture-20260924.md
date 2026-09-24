# Guided exterior photos — September 24, 2026

## Experience

Mobile Full Structure ordering now follows map/pin confirmation, eight guided
photo views per structure, a photo summary, customer/details, and final review.
The guide starts at Front, then Front Left, Left, Back Left, Back, Back Right,
Right, and Front Right. A CSS 3D house rotates between angles. The camera preview
stays mounted during upload renders. Users can skip, return, upload files,
take multiple photos, change the primary, remove photos, and retry uploads.
The latest shot is primary; earlier shots remain additional references with
validated angle metadata, including through draft restoration. The summary
also supports additional capture/upload. Existing flag gates and the strict
final requirement for eight distinct primary views per structure remain.

Camera access uses video-only getUserMedia with a rear-camera preference.
Permission denial falls back without repeated prompts. Old native builds use
the camera file picker; unsupported browsers retain file upload. Tracks stop
on leaving capture, modal close, reset, visibility loss, and page exit. Async
camera/capture results are discarded when their session is no longer current.
Android accepts video permission only for the trusted portal origin, with an
OS camera permission prompt. iOS advertises its existing WKWebView permission
support, but a signed iOS build was not produced on Windows.

The full-order test exposed a pre-existing createProject omission. Customer
Full Structure projects now retain measurement_scope and exterior_references;
internal-only scope remains exclusive to the internal full-house path.

## Source and verification

Source commits: `3d0bc1e`, `5323daf`, and `c0a4720`. They were merged with the
concurrent assistant work into canonical remote commit
`aa6fa40ba0bc84104d30f505dfbb832fd232a790` using the isolated
`guided-exterior-release` worktree. The main working checkout's unrelated
dirty files were preserved; it remains behind those remote merge commits.

- 19 focused browser, photo-state, mobile sequence, and draft tests passed.
- Full-order integration test passed after the persistence correction,
  including flags, CSRF, missing/duplicate references, angle validation,
  pricing, paid queue artifacts, and the unchanged roof ordering path.
- TypeScript build and frontend syntax checks passed.
- Chrome at 320 and 390 px checked camera permission fallback, persistent
  video across retakes, primary switching, summary navigation, track cleanup,
  and horizontal overflow. Camera input was simulated, not a physical phone.
- Android assembleDevelopmentDebug and both OriginPolicy unit tests passed.
  Physical Android camera/visual acceptance is still to be performed.

## Development runtime

Initial targeted release `5c63c2adb6d3b9b6bd1ca2bb1d527a7d9ab24f28`
preserved web baseline `fd0d9266b1952d4e59b77b386b3fde3dda618184` and
compatibility baseline `0068a9616c31d82ad74f3f3d1e58771a49ad308c`.
Web delta: two frontend scripts, two TypeScript sources, their two compiled
modules, and release.env. Compatibility received only those backend sources
and compiled modules. The follow-up web release
`aa6fa40ba0bc84104d30f505dfbb832fd232a790` changes only the guide's rotation
direction and release.env. Compatibility remains on the initial release.
Worker, production, topology, and autoscale images were not changed.

Each stage verified the prior target source hashes and an explicit file delta
allowlist. Activations guard the previous current symlink and restore it on a
readiness failure. All three activated roles passed exact-release readiness with development
data and enforced outbound isolation. Both final public frontend hashes
matched. Four public readiness requests reached do-598520065 at the final
release; do-603124965 also passed direct local readiness. Both private APK
hashes and download version/path settings were checked after activation.

Final frontend SHA-256:

- exteriors.js: `eee93d2463da8769b3b62d5cc6523fa18d401927499928fe1d13f40eb8cc7a18`
- project-request/app.js: `553e5a3c116d8606b6bb92923aaeb4a7574ee7b97a101171c060feea82c0ca7f`

## Android download

FirstMate 1.0.2 (versionCode 3), package `ai.firstmeasure.mobile.dev`, keeps the
FirstMate launcher label. Its signing certificate matches the prior 1.0.1 APK.
APK SHA-256: `ff7aa4e219f0dfe02f179eeb2845b12e73578a6bf663fcf7a0e7caf2121ecfe2`.
Both web nodes keep it at `/opt/firstmeasure/mobile-builds/FirstMate-1.0.2.apk`;
mobile-testing.conf advertises version 1.0.2 and points to that private file.
The prior APK and original `.before-guided-camera` drop-ins are retained.
Users must install the update to get the embedded camera in the Android app.
The existing autoscale provisioning gap for private test APKs remains.

Rollback: restore the per-role original runtime above and the original
mobile-testing.conf backup, daemon-reload, restart the corresponding
firstmeasure-development service and php8.3-fpm, and verify localhost:3201
readiness. A rollback does not undo submitted test orders or uploads.
