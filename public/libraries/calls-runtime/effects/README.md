# Local camera effects runtime

Vendored `@livekit/track-processors` 0.7.2 (Apache-2.0),
`@mediapipe/tasks-vision` 0.10.14 (Apache-2.0), and MediaPipe selfie
segmenter float16 model version 1. All processing runs in the browser.

The two imports in `track-processors.mjs` point to the local vision module
and an adapter to the existing LiveKit SDK logger. Other upstream code is
unchanged. Camera setup supplies local WASM and model paths; no runtime CDN
or model download from a third party is required.

Sources:
- https://github.com/livekit/track-processors-js/tree/v0.7.2
- https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.14
- https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite

Reproduce by extracting the pinned npm tarballs, copying the dist module,
vision_bundle.mjs and wasm directory, and applying the two import changes.

Required binary assets (SHA-256):

- `wasm/vision_wasm_internal.wasm`: `f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc`
- `wasm/vision_wasm_nosimd_internal.wasm`: `38b61feab2fd7934e05cbe9f68baa308978a5e3b7f85c1913bb8ae89b8ef8b97`
- `selfie_segmenter.tflite`: `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`

Both WASM variants come from the pinned tasks-vision package; verify its npm
integrity before extraction. The model comes from the versioned URL above.
These files must ship alongside the JavaScript; the wrappers alone cannot run effects.
