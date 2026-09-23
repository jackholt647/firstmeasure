# Photo wheel control-panel scope — September 23, 2026

Release `df21902`, based on runtime `b7b759cf7d848b9e5dc1dfccad2593ebc8026bf9`. Only resource_3d_overlay.js changes. Wheel zoom applies exclusively inside the Photo reference controls on the right. Scrolling anywhere on the canvas, including over the photo, goes to model controls. The image hit test and cursor anchoring introduced in the previous release are removed; panel zoom keeps the image center and existing persistence.

Both browser checks pass, including explicit image-area and outside-image pass-through, isolated control-panel zoom, existing dragging/sliders and per-image persistence. Evidence: output/photo-wheel-controls-tests.log and output/photo-wheel-controls-20260923/. All three development roles activated successfully. Staging verified unrelated public files unchanged; the public script hash and readiness match the deployed release. Production is unchanged.
