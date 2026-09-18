# Development generated flashing junction cleanup — September 18, 2026

Runtime: `c21a7a8fb9f8ef433e239edebf6fd3f986d1fe99`.
Baseline: `e35244102a4f7c6e8fc952287d9f5ee7b225b2b6`.

The saved roof junction had 7 mm flashing-plane drift, exceeding the previous 5 mm cleanup limit. Its adjoining source-roof wall also had slight angular drift. Separate overlapping wall strips produced hidden or duplicate-looking seams.

Generated flashing alignment now accepts up to 10 mm drift, retains source/target roof provenance and angular checks, and aligns a touching source-roof run only when its complete displacement is within one inch. Its far corner intersects the neighboring wall plane so that adjacent gable coplanarity is retained. Existing exact coplanar grouping then removes the internal seams. No general coplanarity tolerance was relaxed and no saved user geometry is automatically rewritten.

Validation: 846 local regression tests passed; 32 focused staged Linux tests passed. A geometry-only saved fixture tests the merged selectable face and absence of internal full-height edges at three rotations, along with neighboring gable alignment and closed ground boundaries. Negative tests retain unsupported offsets. An isolated before/after boundary rendering was inspected.

Deployment changes one runtime file, wall_geometry.js. Staging verifies 18,100 unchanged public files on each role. All development roles use the guarded activation and readiness/outbound-isolation checks. Production, access settings and prior roof-fitting/skylight/editor changes are retained. Public and local served bytes are checked against the committed file.

Refresh and run From Roof to regenerate existing walls with this cleanup. This is a geometry regeneration operation; existing manually edited geometry is not silently replaced on reload.
