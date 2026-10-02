# Development: project action entry and Notes cleanup

Verified development release: `14954ceac292ba89e9d29189aa958841e6d92c0a` (includes `a13907c16642d10ec5b438715f565c7b00f34d68`).

Normal project opens no longer infer an active report workflow or Roof selection from a saved unfinished draft. Explicit report entry still uses its saved data. Overview hides Order Report when an actual report order exists. Initial actions use full-width compact rows with consistently aligned icons and labels. Notes retains permanent history and removes the redundant History composer label.

Validation: 25 targeted behavior/browser checks passed, including remote and cached draft hydration, explicit report entry, ordered-report action visibility, header/tray behavior, synchronized fields and narrow layouts. The three style checks were rerun after the final action-row adjustment and passed.

Deployment status: activated and verified on web, legacy and pool. Public asset hashes match the release. Live browser verification confirmed compact 40px action rows, removed History label, and action restoration after refreshing an abandoned report draft. Role-specific live baselines are retained in `output/project-abandoned-report-20261002/manifest.json`; only the two owned browser assets are overlaid. Backend, runtime configuration and production are unchanged.
