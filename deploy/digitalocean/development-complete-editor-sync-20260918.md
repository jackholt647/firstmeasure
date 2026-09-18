# Complete local exterior editor sync

Runtime release: `b77f3943131657b76e10429c2082ed1cb25fdd52`.
Baseline: `af50a6f11117c9cd208d9d42c6af1efc43f75848`.
Branch: `codex/opaque-depth-sync`.

## Scope and reconciliation

Previous incremental releases omitted completed local editor work. This release reconciles the whole local editor with the active development baseline: Tab display-mode cycling; Speed diagnostics and copying captures; queued frame updates, persistent scene/PBR caches and drag optimizations; trim-follow and opening-trim tools; updated rendering, finish handling and exterior reports/PDF layout. It includes required editor script tags and backend PDF renderer dependencies/recipe version.

Three-way reconciliation retains the newer development tutorial/access restrictions, training submission behavior, PDF obstacle labels and project-search fixes. Those merged entrypoint/report/backend files were also brought back to the canonical local checkout so future syncs do not reintroduce older versions. The full editor-script and rendered-asset trees match locally after line-ending normalization. No project data or production changes.

28 runtime files are deployed, including three new browser modules and the two rebuilt backend JavaScript files. The compiled backend differences were inspected: only the intended PDF recipe/dependency changes differ from the live baseline. Other compiled modules, dependencies, configuration and development service overrides are preserved.

## Validation

- 838 exterior tests passed, including actual WebGL/browser checks and Tab behavior in drawing mode, with text-input and roof-mode exclusions.
- TypeScript build passed; PHP entrypoint/resource lint passed.
- Three backend integration tests passed, including PDF upload, reference uploads and exterior tutorial/access boundaries. Reference upload test was rerun after correcting its Buffer request-body typing.
- 830 non-browser tests passed against the Linux staged release. Six additional browser tests could not launch there because Chrome is absent; these passed in the Windows suite. The separate line-depth browser tests also passed in that suite.
- All 65 editor scripts fetched from the public dev URL match the tested release.
- Full parity manifest verifies 89 editor, texture, source and compiled backend files on all three development roles. See `development-complete-editor-manifest-20260918.json`.

## Deployment

Worker, web and compatibility roles activated successfully. Public readiness confirms the expected release, development data, and enforced outbound isolation. Delta staging verified 18,073 other runtime files unchanged per role. Existing experimental access and production remain unchanged.

Artifacts on each host: `/tmp/editor-sync-delta.tar.gz`, `/tmp/editor-sync-delta.json`, `/tmp/deploy-editor-sync.py`, `/tmp/editor-complete-manifest.json`. Linux test log: `/tmp/editor-sync-validation-b77f394/results.log` on worker.

Refresh the editor to load the release. No From Roof regeneration is needed just to enable these features. Future releases should compare the complete canonical editor tree with this reconciled baseline, rather than treating only one requested fix as the full local feature set.
