# Development multi-point H/V cuts — September 18, 2026

Runtime `6500d2fb9d1cddf30a7173c046d14e1adde7b487`; baseline `f605ec2e2185bf07172ee35825aa8d96ec07cf70`.

V/H discovers cut candidates for every selected point and previews the batch together. Repeating the shortcut cycles adjoining-face choices; click commits one undo transaction and Escape restores the geometry and point selection. Points with no valid cut are reported and skipped. Validation failure restores the entire batch. The base-layer shortcut forwards multiple selected points through the same operation.

884 regression tests passed, followed by the additional focused base H batch test (885 total). Coverage includes V/H from two points, cancellation and selection restoration, one-step history, two wall drafts, and two cuts across a base. Root files were synchronized only after comparison with their prior committed baseline.

The three-script development delta preserves all other runtime files. Verify readiness, development isolation and public bytes on activation. Production is unchanged.
