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

## Activation and live verification

Initial restoration: `880e1216b9b2438e952bed3f162b62e18584f69f`. Final runtime:
`46d41f7f4967ca29a4fb9ca70acdde485365074c`, including the narrow-screen
sidebar correction. Web, compatibility and pool serving roles activated and
passed source-hash and development-readiness verification. Outbound safety
remains enforced. Worker and backend implementations are unchanged.

Live desktop and 390px phone checks passed without asset overrides or browser
errors: Scope widgets remain visible, roof selection retains material lists,
View scope returns to source context, and refresh leaves the ledger revision
unchanged. The phone material area is 372px wide with no content overflow.
The material-service browser test additionally covers manual creation, generation
review, editing, ordering and retained outstanding quantities.
