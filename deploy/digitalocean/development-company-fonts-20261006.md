# Company font visibility — October 6, 2026

Runtime release: `c25306f378111ec534a0fdf34a16f251a7c29a7c`.

Company information shows the shared brand-kit font controls only when
`platform.documents` is enabled. Documents is off by default for FirstMeasure
accounts. Document Studio retains its existing font controls. Saving company
information or autosaving colors/logos while fonts are hidden preserves the
existing branch and presentation-style typography.

The release contains only the company settings asset, shared brand-kit asset,
and their manifest cache versions. Per-role three-way overlays retain concurrent
development assets; secrets, data and backend implementation are unchanged.
The worker does not consume these UI assets and does not require activation.

Local JavaScript syntax and font visibility checks passed, including the
Document Studio default. Linux staging validates every changed JavaScript file.
Deployment manifests, live baseline hashes, role-specific prior release paths
and final verification receipts are retained in
`output/company-fonts-20261006/`.

Code rollback restores each role's recorded previous path and restarts that
development role with PHP-FPM reload. Inspect intervening deployments first.
No business-data rollback is needed. Production is not part of this release.

Activation completed on web, compatibility and pool. Final checks verified all
three deployed file hashes per host, the runtime release, readiness and enforced
development isolation. Hosted assets passed the font-off/font-on markup checks
and retained the Company information Documents gate. No full signed-in browser
flow was rerun for this small visibility change.
