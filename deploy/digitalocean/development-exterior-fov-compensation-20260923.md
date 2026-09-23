# Development FOV compensation — September 23, 2026

Release `bd46f13dda3bfcc183c9cfeecfb224e78275fc49`, baseline `52e3e76ea4c0af3659e0f98d05dd0ccbc7761278`.

FOV changes multiply camera distance from the orbit target by `tan(oldFov/2) / tan(newFov/2)`, keeping apparent scale at that target while changing perspective. Orbit target and heading remain unchanged. Zoom distance limits follow the same ratio, and far clipping expands when necessary. Objects at other depths still change relative scale as expected for perspective. This intentionally changes camera position, including height along the orbit ray.

Slider dragging uses pointer capture, suppresses native text dragging, reserves a fixed readout width and avoids writing the range value during an active drag. Pointer release/cancellation restores normal synchronization.

Nine tests passed across scene FOV, FOV drag, metric scale and render pipeline suites. They cover off-origin target framing, repeated FOV round trips without distance/limit drift, keyboard-compatible native range behavior through existing input handling, and actual headless Chrome pointer dragging across the range while live synchronization runs. Live authenticated editor visual behavior was not inspected.

Only `public/measure/internal/editor_scripts/scene_3d.js` changed in the deployed runtime. All other public files were verified unchanged. Web, worker and legacy roles activated and passed development readiness/outbound isolation checks. Public SHA-256 matched `ad1343f379d959b49c73fa5c1b405c4e8899dbef6752f64855ee473423fb42ab`. Production is unchanged. Local manifests are under ignored `output/exterior-fov-compensation-20260923/`.
