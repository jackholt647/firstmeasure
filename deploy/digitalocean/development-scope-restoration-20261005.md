# Scope workspace restoration

The October 3 materials UI incorrectly bypassed the Scope app's existing loading,
sidebar and list rendering. This correction restores that workspace and embeds
document material sets within its material review area. The user authorized
deployment to dev.1m8.ai on October 5; production is outside this release.

Roof, aerial, measurements and list widgets remain available on the left.
Document scope shows accepted input values and the selected material set's source.
View scope selects that context without replacing the workspace. Existing scope,
labor and equipment lists retain their controls. Document sets retain independent
lines, amendments, commitments and delivery allocation through the existing ledger.

The project UI no longer exposes calculation source, definitions or raw JSON.
Manual creation produces a usable list. Generate materials evaluates document
inputs and opens the quantity review directly when no additional inputs are
required. Changed quantities still require explicit application. Opening or
refreshing Scope does not regenerate legacy lists or overwrite material quantities.
The signing outbox continues to publish pending deliverables; this frontend
correction does not add background evaluation to that outbox.

Validation: seven Scope behavior tests; ten materials service/browser tests,
including manual creation, generation review, amendments and ordering; hosted
browser verification with local assets, widget switching, source selection and
read-only refresh. No browser errors. Operational artifacts and screenshots:
`output/scope-restoration-20261005`.

Deployment uses immutable overlays of fresh verified development serving-node
baselines, preserving role-specific code and unrelated workspace changes. Only
the two material UI files and their bundle version are deployed. No database or
worker changes. The manifest records previous paths for atomic symlink rollback,
development service restart and PHP-FPM reload.
