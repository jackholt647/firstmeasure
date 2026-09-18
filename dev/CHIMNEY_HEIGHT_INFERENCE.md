# Height-map extension of open chimneys

Open rectangular chimney notches use the DSM during explicit From Roof generation. Closed measured outlines are unchanged. The result and its measurement summary are persisted with the chimney; rendering, stage changes and reload do not resample the raster or reinterpret edited geometry.

Five strips sample from the known interior outward. Nearby roof planes touching the measured outline provide the reference elevation, including pitched roofs and ridge crossings. At least three strips must agree on a sustained height drop; isolated low pixels, nodata and incompatible strips cannot alone determine the edge. Known interior geometry is retained.

The detected front snaps to the open roof crossing when within two raster pixels (bounded between 10 and 30 cm). A clear extension beyond that tolerance remains beyond the roof. Unresolved, coarse or absent height evidence retains the existing mirrored-depth fallback. The search is bounded to six metres and is performed only at generation time.

The base and chimney walls consume the same inferred footprint. Regression coverage includes the anonymous raster crop from the saved stepped-eave house, roof-edge and beyond-edge cases, missing/noisy data, rotated and pitched geometry, closed outlines, persistence, generation-only sampling, and closed wall/base results for Auto, 12-, 18- and 24-inch soffits.

In the saved example, all five strips agree on 0.379 m (14.94 inches) beyond the roof crossing, compared with the old 0.650 m (25.60 inches) mirrored guess. This is a height-map estimate, not a surveyed measurement. No project metadata, address or imagery identifiers are included in the regression crop.

Run `node --test dev/wall-chimney-height.test.cjs dev/wall-mode.test.cjs`. Optional private WebGL comparison: `node dev/chimney-height-visual.cjs <output-directory>` (Chrome and the existing v1 Playwright dependency required).
