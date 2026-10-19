# Floating-face extrusion — development, October 12, 2026

Source commit `03caa74807442d546266448e6a4042d92b1cd52a`; integrated and pushed through `18319ab5`.

Standalone face extrusion now sweeps the full outer and hole boundaries even
without neighboring supports. Coplanar hosted patches retain supported returns,
including open door thresholds; that policy remains attached to their moved cap.
Detached face movement remains a translation. The selected-solid E path is covered
by regression tests, including exact preview/placement equality.

Validation: 649 geometry/editor tests passed. A browser replay of a selected
sloped floating face confirmed a one-foot World Z extrusion with four side walls
retained after placement. Evidence is in `output/floating-face-extrusion-20261012`.

## Verified deployment

Only `wall_solid_geometry.js` and `exterior_model.js` under
`public/measure/internal/editor_scripts` were overlaid onto each audited immutable
frontend baseline. SHA-256 and JavaScript syntax checks passed. Each activation
guarded the original frontend path, owned-file hashes, backend PID, runtime path,
runtime identity and development isolation. PHP was reloaded; Node was not restarted.

The initially suspected release mismatch was the intentional frontend/backend
split documented in the Notes GIF/picker rollout. Backend release
`8a1250d7334bf6ff0e28569ef78ec30b5999fb9f` and its running processes are retained.
Unrelated deployed files, the worker and production were not changed.

All three roles passed final file hashes, readiness and enforced outbound-safety
checks. Both assets fetched through HTTPS at `dev.1m8.ai` matched the tested source.
No customer project was edited during deployment verification.

| Role | New frontend | Previous frontend |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/03caa74807442d546266448e6a4042d92b1cd52a` | `/opt/firstmeasure/releases/e49449c59441c9fce8e9cd99590e9a4fc7db32ca-notes-picker-layer` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/03caa74807442d546266448e6a4042d92b1cd52a` | `/mnt/firstmeasure_dev_releases/releases/e49449c59441c9fce8e9cd99590e9a4fc7db32ca-notes-picker-layer` |
| pool | `/opt/firstmeasure/releases/03caa74807442d546266448e6a4042d92b1cd52a` | `/opt/firstmeasure/releases/e49449c59441c9fce8e9cd99590e9a4fc7db32ca-notes-picker-layer` |

For rollback, preserve subsequent changes and reverse only these two owned file
patches. If no later frontend changes exist, restore the recorded previous role
symlink and reload PHP; retain the backend runtime and release environment.
Manifests, baseline snapshots, activation logs and public verification are retained
in the evidence directory and remote immutable release receipts.
