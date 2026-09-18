# Development soffit overlap cleanup across offsets — September 18, 2026

Runtime `0edd665db8157b2f31e73a71015ecd5ad7f5504f`, based on `2b0f882317e38f89de377148ef80a6ad1d631a17`. One runtime file changes: wall_geometry.js.

The previous generated-wall alignment handled the 18-inch inset but retained the measured short return/flashing/return chain at other offsets. Mitering that embedded overlap chain produced outward steps, inward recesses and crossed runs.

Source construction now recognizes two near-collinear, same-facing exterior roof edges with a supported overlap and a measured short return/flashing/return connection. It removes that embedded chain before mitering, aligns the inset planes using the deeper offset, and joins the exterior sources at their roof-height crossover (bounded to the measured overlap). Roof intersections inside that resolved seam no longer create internal hanging wall strips. Outside the seam the existing roof constraints remain in effect. Zero setback retains the measured outline; unrelated or substantially offset planes do not qualify.

Validation: 857 regression tests passed. The saved house fixture checks 0.2, 1, 1.5 and 2 ft at three rotations, one merged side, no interior full-height seams, adjacent gable alignment and closed ground boundaries. Negative coverage verifies the measured chain requirement and zero-setback behavior. Before/after plan-boundary renders were inspected at every depth.

The guarded development delta preserves the remaining public files and experimental access, validates readiness and outbound isolation, and activates on worker, web and compatibility hosts. No saved user geometry or production release changes. Refresh and From Roof is needed to regenerate existing geometry.
