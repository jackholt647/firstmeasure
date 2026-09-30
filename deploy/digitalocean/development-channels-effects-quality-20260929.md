# Huddle background quality — development, September 29, 2026

Source/runtime release: `23978a0abd94997ae4999045e801dce041df0aac`.

Camera capture now requests 720p at 30 FPS. Background effects start with
Google's SelfieMulticlass 256x256 float32 v1 model on GPU instead of forcing the
small selfie model onto CPU. The canvas fallback also targets 30 rather than
15 FPS. All inference and compositing remain in the browser; assets are served
from FirstMate's own origin. The pinned new model is about 16.4 MB on first load.
Source URL and SHA-256 are recorded in the effects runtime README.

This is not a higher-resolution trained model. Google's published full-person
selfie models remain 256x256; its 512x512 model segments hair only. Multiclass
provides background, hair, skin, clothing and accessory probabilities and is a
higher-detail candidate, not a universally superior model. Source:
https://developers.google.cn/edge/mediapipe/solutions/vision/image_segmenter

The active LiveKit processor wrapper uses soft confidence masks instead of
binary category masks. It detects foreground/background polarity from model
labels, feathers confidence with smoothstep(0.15, 0.85), and reduces outline
blur from eight to two pixels. It awaits the corresponding segmentation before
compositing, avoids resetting the canvas every frame and removes first-frame
duplication. Render buffers rebuild on actual camera resolution changes.

The processor falls back from multiclass GPU to small-model GPU, then small-model
CPU, on initialization/inference failure. It also steps down when a rolling
processing average exceeds 45 ms after 60 frames. If all processing paths fail,
camera frames continue without the effect. Model selection resets on camera
restart. These are documented local changes to the Apache-2.0 runtime; the
upstream `.mjs` copy remains intact for provenance.

Validation used real Chrome, local WASM/model assets and an official Google
segmentation sample, plus isolated huddle API/device fixtures. The raw model
comparison on this machine measured about 22 ms for multiclass GPU versus
275 ms for multiclass CPU; the smaller model measured about 6 ms GPU/14 ms CPU.
The full 720-square compositor sample measured about 18–21 ms per processed
frame. These are local sample results, not device-wide guarantees or a live
multi-person call benchmark. Rendered outputs were inspected; background/person
pixel assertions verify mask polarity. Moving hair/hand quality still needs
real-call assessment.

JavaScript syntax checks and huddle browser regressions passed, including GPU
model selection, 30 FPS configuration, simulated slow-device downgrade, injected
GPU inference failure with CPU recovery, actual blur/custom processing, camera
restart, audio gating/mute, compact controls and recording/admin lifecycle.
An invalid model URL also recovered to the smaller GPU model. Evidence is in
ignored `output/channels-effects-quality-20260929/`.

The immutable development overlay contains four runtime assets: Channels UI,
bundle manifest, active effects wrapper and the new model. Binary model bytes
are preserved and hash-verified. Existing role-specific files/configuration and
concurrent work are retained. No backend, schema, server dependency or topology
change. Worker and production are unchanged. Existing autoscale image limits
remain.

Rollback predecessor on all three serving roles:
`047ef15c755ff4b7a6e520830ff11d6c3dd80cc2`. The staging guard stopped before
activation while the voice health rollout was completing; the baseline was
refreshed after all roles reached that release. Check for newer releases
before atomic symlink/service rollback; verify development readiness and public
asset hashes after each role. Refresh/rejoin calls to load the reverted runtime.

Final verification: all three serving roles passed release hashes, readiness
and development isolation on `23978a0`. Four public asset hashes (including the
unaltered model binary), JavaScript MIME types and six public readiness checks
passed. The enhanced huddle browser suite passed again with dev-served scripts
and model assets, including GPU profile, slow-device downgrade, CPU recovery,
blur, custom replacement, camera restart and the existing call regressions.
