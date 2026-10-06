# Native camera composition and automatic zoom repair - October 6, 2026

Source release: `08e24e410c8f40d86c5e6097fca38357252cd373` (includes `e49b8ffa`). Development APK: FirstMate 1.0.5, version code 6, package `ai.firstmeasure.mobile.dev`.

APK SHA-256: `08ac9e088e52a7f7ab261cc4943243be507d77b611ac293fcd0ab30515ed3724`. Signing certificate matches the previous development installation; update in place through Settings > App download.

## Changes

The 1.0.4 preview made every ancestor transparent, exposing the project list behind the project window. The repaired web layer draws an opaque surround with a transparent rectangle only at the native preview, across nested iframe boundaries. Overlapping sibling surfaces are hidden for the capture lifetime; original backgrounds, visibility and opacity are restored on stop, failure or cancellation, including cancellation while permission is pending. Resize updates both the cutout and native bounds. Camera controls remain web content above the native preview.

The original native implementation selected only one camera's local zoom range. The repair discovers all CameraX-exposed cameras matching front/rear facing, excludes cameras without video qualities for video capture, and maps their ranges to a common zoom scale. Magnification uses focal length divided by active sensor width relative to the default camera; CameraX intrinsic zoom is a fallback when those characteristics are missing. Zoom chooses the appropriate camera automatically. Logical cameras retain their own lens switching. Persistent CameraX recording permits rebinding the same VideoCapture while retaining one recording. Reported endpoints remain available, with duplicate rounded preset labels removed. There is no phone-model table or user-facing lens selector.

This cannot claim access to OEM-private cameras absent from the public camera provider. Physical ultrawide/telephoto transitions and this customer's exact endpoints have not been observed on a physical device. The emulator proves capture/composition and bridge behavior, not multi-lens hardware acceptance.

## Validation

- 18 guided-camera browser tests pass; six shared phone adapter tests pass. Final native/zoom-focused browser rerun: four pass.
- Nested iframe regression includes an overlapping project list, pending camera permission, visible header/footer/upload controls, resize and restoration.
- Three camera range unit tests cover separate 0.5x wide / 1x main / 3x telephoto cameras, combined 30x maximum, existing logical zoom-out and nonstandard limits.
- Android development build and Java unit tests pass. Both native integration tests pass after final changes: preview/zoom/JPEG transfer/MP4 recording, and the real WebView bridge using the actual web composition helper with a background project-list fixture.
- Visually inspected native emulator screenshot: `output/native-camera-repair-20261006/native-camera-preview.png`; the native image and upload control are visible, opaque header/footer remain, and the background project list is hidden.

## Deployment

Development-only guarded deployment evidence: `output/native-camera-repair-20261006/`. Per-role payload merges retain live unrelated source. A concurrent release stopped the first attempt at its baseline guard before activation; inventory was refreshed before retrying.

The immutable APK is selected by `zzzzz-native-camera-repair.conf`, containing only APK path and version overrides. Prior APKs/drop-ins remain for rollback. Rollback requires reviewing current runtime state, removing or superseding this specific override, and restarting the chosen development service. Production and iOS are unchanged. The web repair also works on the existing 1.0.4 host after refresh; camera discovery requires installing 1.0.5.

Activation and verification completed on web, legacy and pool. Public readiness and outbound development isolation passed; the public camera asset hash is `fdd95c755d311998dced7a100566dbb833c415b452fd7480fa39b4720ddb57b7`. All three running services select version 1.0.5 and the APK hash above. Concurrent deployment changed legacy's release ID to `68aebd0cb6304c7f62477e4533c66e041bfdeb68`; direct verification confirmed its camera asset still exactly matches the role-specific merged payload (`f75e3210948a9243059c4da082fadba0a6d94380076cfa8d1436bf3a402d8153`). It was not rolled back merely to force a common release ID.
