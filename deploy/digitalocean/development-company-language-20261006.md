# Company information language and measurements â€” October 6, 2026

Source commit: `e7f9afaa69364d9c7b12de8848226d71583d53fe`.

Company language and measurement-system selectors now sit in the Company
information card below name, email and phone. The separate localization card is
removed. Desktop uses two columns; mobile stacks the controls. Existing IDs,
company save handling, branch localization/report preferences, regional defaults
and issued-report snapshots are retained. The existing Platform Language and
Units (`firstmeasure.report_localization`) availability flag still applies.
Personal sidebar/assistant settings and module defaults are unchanged.

The candidate browser check used an isolated signup-sandbox company with that
flag enabled, selected metric measurements and French, verified persisted
branch localization and reload values, and checked desktop/mobile layout without
horizontal overflow. JavaScript syntax checks passed. Fixtures were deleted.

The development release overlays only Settings' company asset and its manifest
bundle version onto audited serving-role baselines. No API, worker, database
migration or production activation is included. Staging, baseline/source hashes,
readiness receipts and browser screenshots are retained under
`output/company-language-20261006/`.

Activation and final hash/readiness verification passed on all three serving
roles. The hosted browser check also passed with the deployed assets, including
persisted language/units, reloads and the mobile layout. Its isolated company
was removed afterward. Production was not activated.

Rollback requires inspecting intervening releases before restoring each serving
role's manifest previous path, restarting its development service and reloading
PHP-FPM. Verify readiness and isolation before changing another serving node.
No business-data rollback is needed.
