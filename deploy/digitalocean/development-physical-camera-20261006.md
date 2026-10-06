# Android physical camera discovery â€” October 6, 2026

Source: `c92852b2998ffd6444276f70b30a83f6c4ae1cc0`. Development APK: FirstMate 1.0.6, version code 7, package `ai.firstmeasure.mobile.dev`.

APK SHA-256: `5a45048a466dfead870093855562882fde1380bff39123291d61b7882849eb23`.
Signer SHA-256: `57f8c5714560accd5ef6048dc45678b5194feb033dc11307231072bde5a4eb6a` (same as 1.0.5; install in place, no uninstall).

## Problem and implementation

1.0.5 enumerated only top-level CameraX cameras. Physical children of a logical multi-camera can be absent from that list, so its zoom control could omit ultrawide and telephoto even when Android exposes them.

The inventory now reads CameraManager IDs and every logical camera's physical IDs and characteristics. It computes relative magnification from focal length and active sensor width, calibrating against the actual physical sensor reported at initial 1x when available. One zoom scale automatically selects the route. Child cameras are opened through their logical parent with Camera2Interop's physical output ID, which applies to the bound preview and video/photo outputs. They are not rejected for lacking an independent CamcorderProfile. Video chooses a common advertised stream size where available; preview/JPEG sizes are intersected with physical sensor support. Persistent recording retains the same VideoCapture across rebinds.

Open waits for real capture results. A failed lens transition restores the previous working camera and removes the failed route from the offered range for that session. Web controls accept the returned actual range/value. Stale sessions remain isolated. The opaque preview surround and background-project suppression from 1.0.5 remain.

Development-only camera controls include an explicit diagnostics share action. It returns camera IDs, ranges, active/physical capture results and failures, without account data, images or automatic transmission. A discovered route is not described as physically verified until it produces frames. No phone-model whitelist, guessed physical IDs, synthetic ultrawide or manual lens picker is used.

## Sources and limits

- [Android multi-camera](https://developer.android.com/media/camera/camera2/multi-camera): physical children, logical parents and output configuration.
- [CameraManager](https://developer.android.com/reference/android/hardware/camera2/CameraManager): top-level IDs exclude physical-only cameras.
- [CameraX engineering discussion](https://groups.google.com/a/android.com/g/camerax-developers/c/ZLumxx1sW3o): physical output ID applies to bound preview/video outputs; engineer verified wide video on Pixel 9.

CameraX 1.5.3 source was inspected: `CameraSelector.setPhysicalCameraId` alone does not configure the ordinary single-camera bind path. The implementation therefore uses Camera2Interop. CameraX dependencies are unchanged.

OEM-private cameras cannot be inferred from stock camera marketing. This release addresses a concrete discovery/routing omission but has **not** been exercised on a physical multi-lens phone. A customer's precise 0.5xâ€“30x capability is unverified. The diagnostics enable inspection of actual exposed cameras and successful/failed streams without asking for a phone-specific implementation.

## Validation

- Eight Java unit tests: hidden ultrawide/telephoto children, combined zoom range, inaccessible children, main-only device, origin policy.
- Six Android emulator instrumented tests: real preview/capture metadata, zoom, JPEG transfer, MP4 recording, actual WebView composition helper, stale session rejection, origin/inset/permission coverage.
- 25 browser/adapter tests pass. Additional targeted native regression passes after adding explicit diagnostics sharing checks. Coverage includes rejected physical route range/value recovery, no automatic sharing, no debug control for ordinary clients, background-project isolation and recording.
- Development APK build and signing verification pass. Emulator upgrade from 1.0.5 to 1.0.6 succeeds without uninstalling.

## Development rollout

Evidence: `output/physical-camera-20261006/`. Only the two camera web assets are overlaid onto each live role baseline. The signed APK is immutable at `/opt/firstmeasure/mobile-builds/FirstMate-1.0.6-c92852b2.apk`; `zzzzzz-physical-camera.conf` selects its path/version. Existing APKs and overrides are retained. No production, worker, iOS, database or topology change.

The baseline guard stopped activation during a concurrent development rollout. A transient artifact-storage readiness failure also stopped staging; retry proceeded only after readiness recovered. Live inventory was refreshed and unrelated source retained.

Rollback: inspect current runtime and later changes before reverting the owned web delta. To restore 1.0.5 downloads, remove or supersede only this release's systemd APK override and restart each affected development service. Installed devices require an Android-compatible signed forward update for rollback; changing the server download does not downgrade an installed APK.

Activation completed on web, legacy and pool at `c92852b2998ffd6444276f70b30a83f6c4ae1cc0`. Direct verification confirmed the merged web/legacy camera asset hashes; guarded pool activation verified its manifest. All three running services select version 1.0.6 and the APK SHA-256 above. Public source hashes, readiness, development isolation and enforced outbound safety passed. Public exteriors asset SHA-256 is `1d1cb7daedb2494223efde6b0edca078845e42a46dbf2572206f5714ea29bcf8`; phone adapter is `5bce1428755dbc5efacb4b13ce25eeb995376da908da29cffec0dcb5c2dce6e9`.
