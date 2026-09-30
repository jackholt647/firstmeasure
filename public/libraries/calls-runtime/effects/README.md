# Local camera effects runtime

Vendored `@livekit/track-processors` 0.7.2 (Apache-2.0),
`@mediapipe/tasks-vision` 0.10.14 (Apache-2.0), and MediaPipe selfie
segmenter float16 model version 1. Also includes Google's SelfieMulticlass
256x256 float32 model version 1. All processing runs in the browser.

The two imports in `track-processors.mjs` point to the local vision module
and an adapter to the existing LiveKit SDK logger. The active `.js` processor
has the quality changes described below. Camera setup supplies local WASM and model paths; no runtime CDN
or model download from a third party is required.

Sources:
- https://github.com/livekit/track-processors-js/tree/v0.7.2
- https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.14
- https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite
- https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite

Reproduce by extracting the pinned npm tarballs, copying the dist module,
vision_bundle.mjs and wasm directory, and applying the two import changes.

Required binary assets (SHA-256):

- `wasm/vision_wasm_internal.wasm`: `f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc`
- `wasm/vision_wasm_nosimd_internal.wasm`: `38b61feab2fd7934e05cbe9f68baa308978a5e3b7f85c1913bb8ae89b8ef8b97`
- `selfie_segmenter.tflite`: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`
- `selfie_multiclass.tflite`: `c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0`

Both WASM variants come from the pinned tasks-vision package; verify its npm
integrity before extraction. The model comes from the versioned URL above.
These files must ship alongside the JavaScript; the wrappers alone cannot run effects.

The portal imports the `.js` copies of the three module wrappers. The development static host serves `.mjs` as octet-stream, which ES module loading rejects; `.js` is served as JavaScript. Local imports in the wrapper use `.js` as well. The `.mjs` upstream copies remain for provenance.

## FirstMate quality changes (September 29)

The Channels camera requests 720p/30 FPS and the canvas fallback targets 30 FPS.
It starts with the multiclass model on GPU. The local processor extension
`assetPaths.fallbackModelAssetPath` selects the small selfie model on GPU, then
CPU, if initialization/inference fails or a rolling processing-time average
exceeds 45 ms after at least 60 frames. Failed recovery leaves camera frames
flowing without an effect. Profiles reset on camera restart. Each device makes
its own selection; this is not a server compute setting.

Both models provide confidence masks, rather than hard category masks. The
multiclass model's first confidence channel is background; the single-output
selfie model's is foreground. The compositor detects this using model labels,
uses smoothstep(0.15, 0.85) on foreground confidence, and reduces outline blur
from eight to two pixels. Segmentation completes before the corresponding
frame is composited. Canvas/GL buffers are rebuilt only on resolution changes,
instead of resetting the canvas every frame. First-frame duplication was
removed and processing-time accounting no longer counts inference twice.

These are local modifications to the Apache-2.0 upstream runtime, not a newly
trained model. Retain them when regenerating the active `.js` wrapper. Google's
published full-person models are still 256x256; the 512x512 hair model is not a
full-person background replacement. Multiclass is a higher-detail candidate,
not a guaranteed improvement for every scene. The model costs about 16.4 MB on
first load; the smaller model remains available for constrained devices.
