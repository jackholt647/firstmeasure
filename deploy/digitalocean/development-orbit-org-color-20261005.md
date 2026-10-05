# Full-structure capture organization colors — October 5, 2026

Runtime source: `937037c2376113c128b79c22735db74f2c3956e9`.

Orbital capture buttons, numbered steps, walker clothing, door, roof accents, orbit ring/trail/cone, background tints and photo-guide shutter/progress now inherit the organization primary color rather than fixed green. Secondary button text uses primary-readable. Color-mix derives scene shading and translucent accents from primary, so changes update without regenerating the animation. The recording indicator and caution colors retain their meaning.

JavaScript syntax passed. Four Chrome scenarios (390x600, 412x915, 390x1800, 700x500) checked blue and purple themes and live theme changes for button backgrounds, secondary text, SVG walker fill and door backgrounds. All passed locally and with source fetched from dev. Purple screenshot reviewed. Evidence: `output/orbit-org-color-20261005/`. No reports or customer records were changed by verification.

One frontend file overlaid on each immutable development baseline. Web previous release: `9486cf66c778eccc5004e31b408a85c1b2275a65`; compatibility/pool: `ce57ad563725ee51034f3d47a01dec1506d1d4d3` after concurrent rollout baseline re-audit. Compatibility retains its existing r-left selectors; the full before/live difference was checked before resolving the overlapping CSS hunk. All roles passed final release, source hash, readiness and development-isolation checks; public asset hash/readiness matched. Existing conversation authorization covers dev activation. Production and worker unchanged. Rollback uses the per-role previous path in the manifest.
