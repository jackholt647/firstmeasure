# Shared document and agent Markdown — October 10, 2026

Feature commit: `2a22b914094a9b7e2f7be1da470eba0d2109e22d`.

The shared `FMMarkdown` library provides a versioned representation, safe HTML
rendering, serialization and DocModel import/export adapters. Agent Chat, the
global assistant, Stats replies and Checklists descriptions use it. Document
Agent and Insights reuse Agent Chat. Docs retains its structured source and now
provides explicit File > Insert Markdown and File > Export Markdown commands.
Imports use the existing undo engine and preserve literal template-like prose.
The library also owns document-derived nested list markers. Print/PDF harnesses
embed it; public/customer/document entry points load it before consumers.

Release candidate including multiline-cell preservation and bounded marker fixes:
`5f81741b5b3eaea92620e88dcf28a08bfe041e85`.

Channels and Feed retain their existing message parser for the next phase.
There is no data migration, permission change or production activation.

Validation on an isolated task-only source tree: TypeScript passes, all 16
focused Markdown/agent/widget/presentation checks pass, and all 27 document API
checks pass, including the render harness, lifecycle, payments and workflows.
Raw HTML and unsafe links remain inert; Markdown export reports visual and
unsupported-content losses without replacing the source document.

Development rollout completed on October 10, 2026. All four roles run
`5f81741b5b3eaea92620e88dcf28a08bfe041e85` and pass readiness, development
data/cookie isolation and outbound safeguards. Eight publicly served library
assets match the reviewed hashes. All 17 behavior/browser checks pass using
those hosted scripts, and nine Markdown/agent contracts pass on staged Linux.
Evidence: `output/shared-markdown-20261010/`.

## Reconciliation, activation and rollback

- web: prior `/opt/firstmeasure/releases/c18e2fc0b187d23686f11da4fb36777f2b1bcfeb`; active `/opt/firstmeasure/releases/5f81741b5b3eaea92620e88dcf28a08bfe041e85`; 30 reviewed source/compiled files.
- worker: prior `/opt/firstmeasure/releases/c18e2fc0b187d23686f11da4fb36777f2b1bcfeb`; active `/opt/firstmeasure/releases/5f81741b5b3eaea92620e88dcf28a08bfe041e85`; 5 reviewed source/compiled files.
- legacy: prior `/mnt/firstmeasure_dev_releases/releases/c18e2fc0b187d23686f11da4fb36777f2b1bcfeb`; active `/mnt/firstmeasure_dev_releases/releases/5f81741b5b3eaea92620e88dcf28a08bfe041e85`; 30 reviewed source/compiled files.
- pool: prior `/opt/firstmeasure/releases/c18e2fc0b187d23686f11da4fb36777f2b1bcfeb`; active `/opt/firstmeasure/releases/5f81741b5b3eaea92620e88dcf28a08bfe041e85`; 30 reviewed source/compiled files.

Only the task delta was applied over each role's immutable current release.
Unrelated local/staged work and already-deployed changes were preserved. The
worker receives the document render harness and its model/renderer/Markdown
libraries; browser-only adapters and demos are deployed to serving roles.

Other development rollouts changed baselines during staging and before the
first activation attempt. Guards stopped those attempts before any service
switch; subsequent audits reconciled the newer releases. The compatibility
role's existing mounted release directory is used for same-filesystem hardlink
staging. No storage topology was changed. Final independent staging checks ran
in parallel. Activation proceeded worker, primary web, pool web, compatibility,
with job-idle, source hashes, readiness and public traffic checks. All activations
passed; prior immutable releases remain at the rollback paths above.

The isolated initial suite has 16 passing checks; the corrected table-cell and
marker cases pass in an eight-test unit/browser rerun and the final 17-check
hosted suite. The document API suite has 27 passes. All four final Linux staging
TypeScript checks pass. No live customer records were mutated for browser QA.

Evidence includes `focused-isolated.log`, `focused-table-fix.log`,
`check-isolated.log`, `documents-isolated.log`, `linux-markdown.log`,
`stage5-*.log`, `activate2.log`, `verification.json`, `hosted-verify.log` and
`hosted-browser.log` under `output/shared-markdown-20261010/`.
