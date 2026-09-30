# Projects and Contacts Feed parity — development, September 29, 2026

Source release: `a0d7590b1ad03b492987bf05fcd88648465e5767` on the canonical branch.
The audited previous release is `490f326db6b303ab37d35dd1a7658aef4256fea3`
on both development web nodes and compatibility. Production and the worker
are outside this rollout.

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
the second web node's baseline. All roles were re-audited after it converged to
`490f326`; overlays were rebuilt against that baseline. The already staged web
candidate was reused only after its receipt and content hashes matched.

Activation and hosted verification are recorded below after rollout.

Rollback: check for newer releases, then atomically restore each role's previous
`current` symlink and restart its development web/compatibility service and
PHP FPM, one role at a time. This is a code-only rollback with no data changes.
