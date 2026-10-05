# FirstMeasure settings defaults â€” October 5, 2026

Runtime commit: `46586fcbec7bace446161a6a0b5f0c5f7890e6c4`.
Shared window-controls correction: `0ed4fb7cfca333795dc1eaab6df76fbc5e301c13`.

New FirstMeasure organizations start with Notifications, Money/merchant payments,
Connections, AI Agents/assistant and personal left-column customization disabled.
The same signup policy applies to stored legacy defaults and configured signup
presets, so an old development configuration cannot silently enable them.
The expanded-platform capability ceiling now applies consistently in development
and production; the former development-only Money and assistant exceptions are
removed. The seven production FirstMeasure permission flags are unchanged.

Money's existing dependency gates hide its settings, project-modal tab and payment
onboarding reminder. FirstMeasure report-credit billing remains available. There
is no balance migration or alteration to payment-provider configuration.

Message translation appears only when Channels is enabled. Personal sidebar
width, tabs and layout controls require `platform.left_column_settings`, a new
operator-controlled flag that is off by default. Assistant preferences require
the actual assistant app flag; a configured subscription alone cannot show them.
Empty My Settings sections disappear. Saving the remaining settings preserves
hidden preferences instead of overwriting them.

Shared window-manager and window-shell scripts load independently of assistant
assets. The hosted fresh-account check exposed that disabling the assistant
previously also prevented report windows from opening; this dependency is fixed.

External Connections require `platform.connections`, off by default, throughout
HTTP routes, domain-service execution, webhooks and published data/actions. This
is both a visibility and authorization gate. Expanded-platform organizations
must explicitly enable the capability to use Connections. Personal left-column
settings can be enabled independently for a FirstMeasure organization. Existing
explicit organization configuration is retained; this is not a bulk data rewrite.

## Verification

TypeScript checking passed. Twenty focused backend tests passed, including stale
signup-default suppression, Money reminder absence, and disabled Connections
HTTP/service/publication/webhook authorization. Four browser and asset tests passed,
including five combinations of Channels, sidebar and assistant flags, real
settings saving, and retained hidden preferences. Publication tests passed:
50 passed, one PostgreSQL-only test skipped. Linux staging type and syntax checks
passed on all four development roles. The shared-window correction also passed
its focused regression and Linux PHP syntax checks.

Hosted fresh-account verification and final deployment receipts are recorded in
`output/firstmeasure-settings-defaults-20261005/`. The verification organization
was removed after passing its checks. The hosted browser verified hidden settings,
the blocked Money deep link, reminder absence, denied Connections/assistant APIs,
and a working New Report modal without Money. No customer messages or live card
charges were part of this verification.

## Deployment and rollback

Only owned source/build files are overlaid on audited per-role development
baselines. Concurrent development work, environment files and assets are
preserved. Source/build hashes, original and refreshed baselines, and rollback
paths are retained in the output directory's manifests and inventory records.
Concurrent releases changed baselines during staging; guards stopped those
attempts, and refreshed overlays retained the other releases. Final source/build
verification passed on all four roles. Serving roles run `0ed4fb7c`; the worker's
successor `0562254e` retains every owned backend change. The PHP-only correction
does not require a worker restart. Its three serving-role receipts are in
`output/firstmeasure-settings-window-fix-20261005/verified-deployment.json`.
Serving roles use detached-on-write hardlink staging; the worker uses the
existing reflink/clone path. Baseline changes stop activation for a new audit.

For rollback, first inspect intervening releases. Restore the appropriate
role-specific previous path, restart its development service and reload PHP-FPM
on serving roles. Verify readiness and development isolation before proceeding
to another serving node. There is no business-data rollback.

Production has not been activated by this task. A production release must use
the canonical verified source and current production baseline under the existing
deployment workflow.
