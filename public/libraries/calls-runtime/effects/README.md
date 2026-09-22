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
