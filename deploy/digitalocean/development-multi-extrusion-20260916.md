# Development multi-face extrusion

Status: activated and verified on all three development roles.

## Source and behavior

- Runtime: `770d80ca598917d152b06e8c023f9eec01e530a9`.
- Previous development runtime: `1c3fc2fe458b7b0daee8d288a902353a670a2d13`.
- Source remains on `codex/exterior-trim-controls`, retaining the trim, chimney and palette changes.
- Public delta is only `exterior_model.js` and `wall_face_draft.js`. No compiled runtime, dependency, database, access or production changes.
- E operates on the complete face selection, including stickers and complete faces selected by rectangle-selected vertices. Dragging uses the primary face; all members receive the same signed distance along their independently oriented normals.
- Numeric input uses the existing distance control and unit conversion. Positive distance is outward, negative inward; each face keeps its type and finish.
- Combined sweeps preserve both cuts to a shared neighbor, cancel internal overlapping returns, retain shared anchors and apply each face's existing roof constraint.
- Previews use immutable inputs; invalid previews cannot partially commit. Escape restores geometry and selection; placement creates one undo item and keeps the result faces selected.

## Validation

- All 813 dev tests passed in the isolated release checkout.
- 300 focused controller, batch extrusion, roof sweep, curved surface and face adapter tests passed on Linux.
- Coverage includes perpendicular/opposite normals, sticker metadata, exact 2-foot distance (0.6096 m), drag, repeated extrusion, draft consumption, rectangle selection, cancel, zero distance and invalid-preview atomicity.
- The new release's Linux checkout was repacked with independent Git objects after repeated shared clones reached Git's alternate nesting limit. Only the newly created build checkout was repaired; earlier runtime checkouts were not replaced.

## Deployment

- Artifact `/home/dev/exteriors-770d80c.tar.gz`, 249927069 bytes.
- SHA-256 `fc1bed44862176739a60abf825feb94b3417db14bc3f01849219145733a42982`.
- All three roles staged successfully and verified 1335 unchanged public source files.
- Worker, web and compatibility activation completed with development environment, experimental allowlist and outbound isolation preserved.
- Live browser check in a separate local tab: rectangle selection captured three complete faces; typing 2 produced a 2.00-foot-per-face preview and selected all three results. Cancel restored the 23-point input selection. No geometry edit was saved.

- Public readiness returned healthy, development, release `770d80ca598917d152b06e8c023f9eec01e530a9`; both changed editor modules match the tested Git release. A brief post-restart 503 cleared before final verification.
- Production was not changed.
