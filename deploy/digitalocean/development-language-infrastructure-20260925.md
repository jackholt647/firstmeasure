# Language preferences, translation workflow and QA tester — development

## Scope

Source commit `42cc0e7` (canonical integration `31d0a8e`) contains the shared installed-language registry, separate broader inline-translation targets, company-default translation inheritance, English US/UK targets, Company help tooltip, context extraction/translation packets/import/registration tooling, and console-only live language tester. Only en-US/en-GB interface packs are installed. This code release includes the tooling and initial notes. The Translation Sets task separately completed its 8,985-message context inventory (two entries explicitly unresolved) and dispatched language translation tasks; those evolving data artifacts are separate from this runtime release.

No database migration, provider change, currency change, organization flag change or production activation belongs to this release. Existing notification, mobile and sidebar work is preserved. The original dirty checkout was not reset or bulk deployed.

## Release identities

| Role | Language release | Previous release |
| --- | --- | --- |
| Web `do-598520065` | `3f3b92ada110032f7a03b1fe633be95685fd38ea` | `58e9795228581e779986d8ab654230ebc0088fbd` |
| Web `do-603124965` | `c8417a39f6b88b8790c3dbafbbc347387a01701f` | `0650241d63e37841076ca9670f35a93bc7bd4fa3` |
| Worker | `771f12f78aded530063025d64f5459aa75568e25` | `d79912a656c0efd435f01ea25fa8564bee0676d7` |
| Compatibility | `7456c13e6a95570413656d8e1b6debf993c569ea` | `97b7e018e573f907e2e7406939bfc2623eb80f3a` |

Role commits are pushed on `codex/language-{web,pool,worker,legacy}-20260925`. Each overlay has 52 exact source, generated catalog, documentation/test/tooling and compiled-runtime files. Live role-specific Company files were reconciled rather than replaced with an older shared checkout copy. Unchanged files are inherited through immutable hard links; changed files get fresh inodes. No old releases were deleted.

Concurrent notification rollout completed first. The guard then refused web activation when sidebar and agent CSRF releases changed its predecessors. Web candidates were rebased to the final predecessors above. The sidebar `core.js` and both agent API scripts are explicitly hash-verified as preserved. No language node was activated from a stale web baseline.

## Verification

- 39 focused local tests passed; TypeScript check passed.
- Linux source check, build and language/channel/API/report/context-tooling tests passed with background jobs disabled.
- All four reconciled role sources compiled successfully on Linux.
- Authenticated dev-page preview exercised the tester before activation: 48 live bindings, zero page errors and zero preference writes.
- Activation, public asset/readiness verification and final authenticated browser evidence are recorded in `output/language-deploy-20260925/`.

Final browser testing caught a referenced but previously uninstalled `mobile.9391bf1cc7ff306f.json` catalog. All other 89 manifest targets parsed publicly. The additive completion is coordinated with the subsequent exterior font-fix rollout on both web nodes and recorded separately for worker (`b325f01c499393cbc4aaa298c67964dfdc71820a`) and compatibility (`c5768e62b39b366a6dfddccfd7d3e742c4d8e510`). No source code/build change was needed for that exact catalog from `42cc0e7`.

Final verification confirmed all 90 catalogs on all four roles and all 52 language files (with the explicitly coordinated Notifications function update in Company Settings). The exterior completion used `f517e59` on both web nodes; the subsequent Notifications visual update was rolling through `85174c5` during the final inventory. These successors retain the language release; exact observed identities are in `final-current.json`. Public sampling before those coordinated successors returned 24 ready, isolated responses across both nodes (13 primary/11 pool), and all 13 changed public assets matched. The final authenticated browser check passed with 52 live bindings, zero page errors, zero preference writes and the expected null/inherited en-US translation preference. The temporary verification session was revoked.

The broader catalog audit still flags pre-existing hardcoded strings; this is not a complete translation-coverage claim. The existing development autoscale image limitation remains: running roles are verified, but this task does not change the pool template or certify future replacement provisioning.

## Use and rollback

Run `PlatformLanguage.tester.open()` in the Chrome console, then **Reload & start** once. Subsequent installed-language changes are live and tab-local. Closing restores the account language. See [tester instructions](../../docs/developer-language-tester.md) and [translation workflow](../../docs/translation-agent-workflow.md).

Rollback an affected role by restoring `/opt/firstmeasure/current` to its previous release above and restarting the corresponding `firstmeasure-development-{web,worker,legacy}.service`; web and compatibility also restart `php8.3-fpm.service`. Verify development readiness and outbound isolation afterward. Review any subsequent concurrent release before rollback. No data rollback is required for this additive change.
