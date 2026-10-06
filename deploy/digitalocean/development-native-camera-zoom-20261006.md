# Native Android camera zoom — October 6, 2026

Runtime/source commit: `af9d1e0baeb7939aa8d19c58e880731f20dc729d`.
Development Android application: `ai.firstmeasure.mobile.dev`, version 1.0.4 (code 5).
APK SHA-256: `01206a6b9ead26b5d60043e23986f3f20df8e25972a991116b273feb5d6c7ee8`.

The Android host embeds a CameraX preview beneath the transparent capture area of the existing FirstMate interface. The same web shutter, upload strip, recording controls, zoom presets/slider and pinch gesture remain in the app. Photo and video capture run natively; zoom uses the selected logical camera's reported range and CameraControl. Android handles physical-lens transitions supported by that logical camera. No model-specific table, manual lens picker, fabricated 0.5x option or fixed 3x maximum is used on the native path. Manufacturer-private lens/processing features outside public Android camera APIs cannot be advertised. Browser/older-host capture remains available through its existing path.

The bridge advertises `nativeCameraZoom`, preserves version-1 compatibility and existing main-frame/origin checks, and scopes commands to camera sessions. Stale camera sessions cannot adjust or close a newer session. Native captures transfer through bounded chunks and opaque file tokens, then release their temporary files. CameraX lifecycle binding releases camera access when stopped; backgrounding stops recording. Recordings retain their native measured duration and use the existing upload/review workflow.

Validation:

- Camera/recording browser suites: 26 cases passed, including a simulated native 0.5x–30x range, no lens picker, retained web controls, native video return and background restoration.
- Shared phone adapter: six cases passed, including camera session IDs and bounded file transfer/release.
- Android development APK and Java unit tests built successfully.
- Android emulator exercised native preview, zoom, JPEG capture/read/release and MP4 recording; the actual WebView bridge test verified capture and stale-session rejection. The screenshot in `output/multilens-camera-20261006/native-camera-preview.png` confirms native preview and web controls coexist. Physical multi-lens transitions are not emulated and still require physical-device acceptance.
- The existing origin-isolation instrumentation case timed out in the combined run, then passed in isolation. Other existing native cases passed.
- Mobile API and localization API/browser checks passed. Two unrelated settings-layout contract failures reproduce on the parent commit; evidence is in `settings-baseline.log`. Those source areas were not changed.

The signing certificate matches the existing downloadable 1.0.3 APK (SHA-256 fingerprint `57f8c5714560accd5ef6048dc45678b5194feb033dc11307231072bde5a4eb6a`), so existing development installations can update without uninstalling. APK distribution remains private, behind the existing organization/development flags and authenticated endpoint. Production and iOS are unchanged.

Deployment evidence and guarded frontend/APK scripts: `output/multilens-camera-20261006/`. The native APK is stored outside the web root at `/opt/firstmeasure/mobile-builds/FirstMate-1.0.4-af9d1e0b.apk`. The `zzzz-native-camera.conf` drop-in selects it and version 1.0.4; prior APKs/drop-ins are retained. Rollback must remove or supersede this specific two-variable override and restart the selected development role after checking current deployment state.

Activation completed on the development web, legacy and pool roles. All three verified runtime release `af9d1e0b`, development isolation, and the identical 1.0.4 APK hash through their running service configuration. Public readiness and both deployed JavaScript hashes passed verification. Existing development installations must install 1.0.4 from Settings → App download to enable native capture; refreshing an older APK only updates the web layer.
