# Development textured image ground — September 18, 2026

Runtime `3240bc71374eb13dc65852c81a12f26e033fd8c6`; baseline `cf2f2d99bd18aeafc104360ed5c8fb654b714fd2`.

Textured presentation now displays the enabled reference image on a two-triangle ground plane below the model bounds. It preserves the image mesh horizontal transform and UV alignment, reads the current image texture, and follows Image visibility without a model rebuild. It does not import or flatten the dense source DSM. The presentation owns a cloned texture and disposes it on exit without disposing the editor image texture. Ground imagery receives shadows and does not cast them.

The rendered-mode Playwright browser test passes, including image on/off, flat four-vertex geometry, horizontal alignment, original source preservation and texture lifecycle, alongside PBR, grade/base, export and mode restoration checks. Both changed scripts pass syntax checks. Runtime root files matched the isolated baseline before synchronization; the root test had prior differences, so only the new regression block was inserted there.

Deployment is limited to the two committed scripts on development worker, web and legacy, with unchanged-file verification and readiness checks. Production is not activated.
