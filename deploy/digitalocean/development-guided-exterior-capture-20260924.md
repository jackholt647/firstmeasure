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


## Android fallback screen correction

A physical-device screenshot showed the native fallback branch, an empty video
poster rendered as a giant play icon, and instructions referring to an
unlabelled shutter. The screenshot alone does not establish the installed APK
version. Commit `3e53250`, integrated as `b274a07bf148ba31c24b0d2564842abe6ab41cec`,
waits for PhoneFeatures.ready before deciding whether a known Android host
lacks liveCamera. Missing native metadata is no longer treated as an old app.
The video stays hidden until a live stream exists. The shutter now has visible
Take photo text; old Android hosts get an explicit app-update explanation and
no nonfunctional Retry camera control. Actual camera failures retain retry.

All four browser capture tests pass, including delayed native discovery and
legacy Android picker fallback. Both web nodes receive the single-script
release from `aa6fa40`; native APK 1.0.2 and backend services are unchanged.
SHA-256: `53efb09cb4772b61b62f41cdcb5112f2339c08370889f806fedecc7427428959`.
Rollback restores the retained `aa6fa40` runtime. Physical live-camera
confirmation is still pending; these browser tests simulate camera devices.


## Capture layout refinement

Source `900d5f6`, integrated into canonical commit/release
`582b498091af7a3bfce3401872e6fb5b210d4765`, reduces capture to one view heading
and House/View metadata beside the house diagram. The camera flexes to occupy
the remaining height; its captured-photo strip overlays the preview so taking
a photo does not displace navigation. A centered labelled shutter sits above
the bottom Back / Upload instead / Skip for now row. After capture, the last
control becomes Next angle (Review photos on the final view). The early summary
shortcut, direction paragraph, progress bar, and capture disclaimer are gone.
The photo summary remains the destination after the eighth view.

Additional photos uses one full-width, 170 px minimum-height dashed upload
control. It invokes the normal multi-image picker without a capture attribute,
so the native Android chooser can offer camera and library. File drops there
are assigned directly as additional references for the selected structure.

All five browser tests pass. New measured layout checks at 390x844 and 320x640
verify bottom alignment, camera expansion, stable navigation across all eight
views and after capture, and the normal additional-photo chooser. Existing
camera permission/readiness, retake, primary-selection and upload checks pass.
Visual review used simulated camera frames. This is a frontend-only update;
FirstMate 1.0.2 remains the downloadable native build and needs no reinstall.

The web-only delta from `b274a07` contains exteriors.js and release.env. Both
nodes use guarded activation and local exact-release readiness. Final script
SHA-256 is `0deefae56249bd808ec036c003bd3aeb78d257b04bee3e168210d59f9e984754`.
Compatibility, worker, production and APK settings are unchanged. Rollback is
the retained `b274a07` runtime.


## Immediate photo feedback and square thumbnails

Source `9731254`, integrated into canonical release
`f36e58a18dec70c473cfcad3a10ae4481c9daabe`, reserves each captured photo and
renders a small local preview synchronously before asynchronous JPEG encoding
and upload. Encoding and upload are per-photo pending states and continue to
gate final submission; neither locks the shutter. Pending photos can be
selected as primary or removed, and delayed results cannot resurrect removals.

Thumbnail DOM nodes remain keyed to their photo across status and primary
changes. Tiles are square, with a top-right remove circle, darkened spinner
while pending, and a colored outline/Primary label only for the selected tile.
Selecting a tile directly makes it primary. Saved labels and separate Make
primary buttons are removed. The pinned Upload tile sits outside the horizontal
strip; its adjacent edge masks scrolling thumbnails with a short fade.
Capture feedback flies to the strip and pulses the shutter. Angle changes
animate the heading and strip alongside the rotating house. Capture/angle
transitions respect reduced-motion preference.

Back, centered Take photo, and Next angle now share one bottom row. On empty
angles the last control still offers Skip for now; the final angle leads to
review. Review remove buttons are explicitly 32 by 32 pixels. The previous
summary min-height rule now targets only view buttons, not the remove button.

All 15 browser/state tests passed. The new delayed-encoding/delayed-upload test
checks immediate thumbnails, a usable shutter, five captures, stable layout,
primary switching while pending, pinned Upload during horizontal scroll,
removal before encoding completes, and absence of Saved text. Review remove
button dimensions are measured in the layout test. Browser visual checks use
simulated video frames, not a physical camera.

The single-script web delta preserves `582b498` as rollback. Both web nodes
use guarded activation and exact-release readiness. Script SHA-256:
`9c9699b00741e21c161923338cb9b67cf8f134eca08d9430bfb13162179b37df`.
No native APK, backend, worker, compatibility, or production changes.


## Compact shutter and grouped photo summary

Source `3c58d45`, integrated release `cefc0f3db9ed0ec02eb69fbc0ebb8e2bc40bcfdd`.

- Removed the visible shutter caption while retaining its accessible name; camera gains the freed height.
- Mobile photo summary reuses the capture tiles in responsive four-column grids grouped by house and angle, plus Additional photos. Primary selection, upload spinner, retry and circular delete controls are shared.
- Kept the large additional upload target at the top and preserved native chooser behavior.
- Unavailable photo-summary Next remains grey but accepts activation to explain missing angles, upload failures, pending uploads or unassigned photos. Navigation remains gated.
- Seven camera/browser checks and eleven state/navigation checks passed, including primary switching, pending captures, four-column wrapping, square controls and missing-angle feedback.
- Targeted two-script rollout on both dev web nodes preserves runtime baseline `418cb77b52bcf933c93693f13621e27bba8ea409`. No native rebuild required; production unchanged.

Both serving nodes passed development readiness with the new release ID. Public SHA-256 checks matched both committed scripts.

## Directional overview and shutter containment

Source 18d915b restores the eight-direction primary-photo diagram below the additional upload target and additional thumbnail grid. Completion headings are removed; grouped angle tiles remain below the diagram. Footer padding contains the full shutter outline. Seven browser regressions pass, including diagram presence, ordering and shutter containment. The one-file development delta preserves the concurrent d224b18a43316b6a64d22b469cb2baca0775ff86 baseline. Production is unchanged.

Activated release 50e1bcaf56c2397d908f653c5c924e7644dd7813 on both dev web nodes. Both passed readiness; the public exterior script matched the committed hash.

## Final review photos and compact contact details

Source 3f60464, integrated release 54fcd99f4204250534cd12e241fad8c91f3b1c4b. Final review separates report/customer/pricing from Photos, with an eight-direction primary-photo grid per house and required/additional/total counts below. The existing bottom-right Order action is retained. Customer information heading sits above the contact cards on mobile Details; nested contact field margins are reset and the gap to notes is tightened. Ten camera/navigation browser checks passed, including final-review section and photo assertions. Two-script development delta preserves 91046fca06b533a381223366db14161ab78779d9; production unchanged.

Both dev web nodes passed readiness for 54fcd99; both public script hashes match the committed source.

## Photo-first final review and matching customer input text

Source 8d7b6ea, currency-fixture update 4e7941e. Removes the Full Structure-only 16px input override; mobile customer name, phone and email use the same 13px size as standard mobile inputs. Computed-style browser check confirms all four fields at 13px. Review title is now "Review your full structural report", followed by the eight-direction primary photos and counts, report details/total, and delivery timing. The redundant Photos heading is removed. Seven guided camera checks passed, followed by the final-review ordering check with the updated shared currency fixture.

Release artifact f517e59d39ae19b4b158dc3556dead3013d01f8b changes only exteriors.js. Activation coordinated to follow the language rollout, preserving its runtime files. Production unchanged.

Coordinated with the language rollout: web baselines 3f3b92ada110032f7a03b1fe633be95685fd38ea and c8417a39f6b88b8790c3dbafbbc347387a01701f are preserved. At the language task's request, the delta also adds its missing manifest-referenced public/libraries/platform-language/catalogs/mobile.9391bf1cc7ff306f.json, exact immutable bytes from42cc0e7, SHA2560922494a2d4ee836d6f501389d26b7c3bdaf1b52414d759aef5ec5a1f7152ee4. Explicit diff guard allows only that new catalog, exteriors.js and release.env.
