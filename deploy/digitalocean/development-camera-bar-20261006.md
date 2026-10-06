# Mobile camera bar and zoom fallback — October 6, 2026

Runtime commit: `f08f6b61c48d3b6e75473c7e5756d65d2c24b663`.

Mobile camera controls appear when the capture view opens, before permissions or camera startup complete. A 240ms slide/fade respects reduced-motion preferences. Controls are disabled until usable. The upload strip is positioned from the actual control bar height with a 10px gap, matching the camera-bottom inset.

Hardware zoom still uses track capabilities and constraints. If a mobile camera exposes no usable zoom range, presets, slider and pinch use 1x–3x digital zoom. The preview, photo crop, thumbnail and recorded video share the crop. Video uses a canvas capture stream capped at 1920px on its longest side and 30fps; its timer and tracks are released when recording stops. This is digital cropping, not an invented ultrawide lens. Desktop controls remain hidden.

Validation: 15 guided-camera checks and nine orbital-video checks passed, plus a new digital-video crop/stream-release check (25 total). Cases cover initial permission-pending controls, animation, exact upload gap, hardware zoom, digital photo/video crops, camera switching and desktop exclusion. A mobile browser screenshot was inspected. No physical Android device was attached; physical-device camera capabilities and performance remain to be exercised. Canvas capture follows the standard described at https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream.

Development rollout is a single-file immutable overlay preserving compatibility-host source differences. Evidence is in `output/camera-bar-20261006/`. No native binary or production activation is included.

All three frontend roles activated successfully. A concurrent release advanced web to `8dd70617b282cbb146886ab7eb7713057bfd5166` before final verification; refreshed inventory confirmed it retains the exact camera payload. Compatibility and pool verified at this task's runtime commit. All three camera asset hashes match their expected payloads; public readiness and development isolation passed. Public asset SHA-256: `7fad3ff3d622d63ed69c235d7d56da62f2e2896a46f6bb37cf5bc03d55a7d299`.
