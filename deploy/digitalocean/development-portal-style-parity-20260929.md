# Projects and Contacts Feed parity — development, September 29, 2026

Code commit: `a0d7590b1ad03b492987bf05fcd88648465e5767`. Development release:
`4dac5e2e3a06026500ece6b5851b3524fc69b890` on the canonical branch, with
identical task source and the release preparation record.
The audited previous release is `8eaaad2d74244479cda4b603640ebbd9a7336420`
on both development web nodes and `490f326db6b303ab37d35dd1a7658aef4256fea3`
on compatibility. Production and the worker are outside this rollout.

My Projects and My Contacts use Feed's colored title icon, 38px controls,
10px control corners, grouped view selector and primary-tinted selected state.
Project view labels remain visible, including on phones. Projects has a larger
title without its item count, and the board picker remains below the header.
Manage view uses the Shown menu's panel and option-card styling. Cards have the
lighter Feed borders, smaller corners and restrained shadows. Contacts retains
search, sort, list/tiles, import, refresh and contact/project opening behavior.

This release also delivers the preceding scope-derived project columns: shared
address and primary contact details, configured project fields and scope inputs,
and explicit measurement report fields only for workflows referencing report
integration. Field reads reuse the custom-field service's authorization and
formula evaluation; missing values do not fall back to legacy order data.
Column choices are retained per board and the same options drive stage sorting.

The overlay contains the two tab scripts, their role-specific bundle tokens,
three Work source files and their three compiled JavaScript counterparts.
Each role starts from its verified current release; other source, compiled
modules, configuration, private assets and data are retained. Compatibility's
existing manifest differences are preserved. No migrations, dependency changes,
feature changes or production activation are included.

Validation: clean-commit TypeScript build; 13 Work API tests; two field-catalog
tests; browser checks for project view/sort/columns/board switching and contact
search/sort/view switching/contact and project links; desktop/mobile screenshots;
Linux import and syntax checks during staging. Deployment evidence and guarded
rollout scripts are in ignored `output/portal-style-parity-20260929/`.

The initial staging guard stopped when a concurrent notification rollout changed
the second web node's baseline. A subsequent Overview/project-detail rollout
changed the web baselines again. All roles were re-audited, and the replacement
immutable candidate was staged against the final per-role baselines above.
The older unactivated candidate was retained; no live release was edited.

All three roles activated successfully, with development isolation, readiness,
source/compiled file hashes and automatic rollback guards checked on each host.
The three public frontend assets matched their expected hashes. Six public
readiness responses reported the new development release and enforced outbound
safety. Both browser fixtures passed again using the scripts served by
`dev.1m8.ai`, including desktop/mobile controls and preserved interactions.

Rollback: check for newer releases, then atomically restore each role's previous
`current` symlink and restart its development web/compatibility service and
PHP FPM, one role at a time. This is a code-only rollback with no data changes.
