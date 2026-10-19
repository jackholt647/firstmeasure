# Development Feed terminology and workflow context — October 11, 2026

Implementation release: `3ab03d8a09a09ac287fcef3de46d4cebb60e3fe5`, branch `codex/feed-permissions-autosave-20261010`.

## Focused changes

The branch-scoped terminology runtime resolves generic display nouns; route IDs, event names and saved setting values remain stable. Feed now reads that runtime for generic project/document/proposal/customer/material/invoice/receipt labels and relevant filter labels. Feed and its Settings component re-render when terminology updates. Authored document, stage, scope and task names are not rewritten through terminology substitution.

Authorized activity responses include a small presentation descriptor from the shared event registry, plus actual work-plan/task titles when their referenced records pass project/resource authorization. Only names are returned; definitions and task metadata are not copied. Per-request lookups are cached. List now renders scope start/completion and named task completion, and includes scope context for manual stage moves. Missing actor information uses a neutral System label. A scheduler-ended window is labeled as a scheduled event ending when its recorded facts identify that path. Unknown event types use registered descriptions or a neutral activity label, not internal identifiers.

Settings choices come from registered activity events rather than a Feed-owned list. App flags suppress new choices for disabled apps, while previously observed or saved choices remain available. Scope/task activity choices exist before the first event occurs. The old `project.event.completed` setting retains its stable ID but is accurately labeled Scheduled event completed. The old Job completed business label is removed.

Existing Proposal/Contract signature selections match canonical `document.signed` events by document type/tags; proposal compatibility-source events also match. Explicitly clearing those selections still suppresses them. Existing settings defaults and audience selections are preserved.

This is a Feed presentation/catalog pass. It does not change workflow execution, add stage-transition producers or stage-specific subscription rules, alter the event history, or remove the current 500-event catalog limit. Those broader changes remain separate architecture work.

## Checks and rollout

- Local TypeScript check passed.
- Feed API suite: 6 passed, including actual scope/task titles and denial of those titles without resource permission.
- Terminology/signature tests: 2 passed, including changed terminology, non-construction scope names, generic unknown events and canonical signature matching.
- Feed layout browser regression: 1 passed on desktop/mobile with the newly visible scope-start row.
- Feed Settings browser tests: 2 passed for missing-component retry and auto-save/default/conflict behavior.
- Terminology/signature and Settings tests also passed using publicly served development scripts.
- Each staged host passed syntax checks, a full type check and a separate runtime compilation. The ten task source/compiled files are recorded in each role's `feed-permissions-release.json`.

Each role was cloned from its audited current release, preserving concurrent work. Activation is sequential, with previous release paths retained for rollback. Before rollback, inspect current pointers because later deployments can advance them.

| Role | Release path | Previous path |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/3ab03d8a09a09ac287fcef3de46d4cebb60e3fe5` | `/opt/firstmeasure/releases/d336f3ae-registration-stage` |
| pool | `/opt/firstmeasure/releases/3ab03d8a09a09ac287fcef3de46d4cebb60e3fe5` | `/opt/firstmeasure/releases/d336f3ae-registration-stage` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/3ab03d8a09a09ac287fcef3de46d4cebb60e3fe5` | `/mnt/firstmeasure_dev_releases/releases/d336f3ae-registration-stage` |

Restart the existing role service and PHP-FPM after restoring its own previous pointer, then verify local/public readiness and development outbound isolation. Worker and production are unchanged.
