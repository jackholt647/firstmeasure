# FirstMeasure billing viewport — September 24, 2026

Development release `0068a9616c31d82ad74f3f3d1e58771a49ad308c` is active on
both web nodes and compatibility. Production is unchanged.

The FirstMeasure-only Billing page now fits the settings viewport. The credit
balance and monthly statement occupy fixed layout rows; billing history alone
scrolls through the remaining space. Auto-top-up controls stay inline on roomy
screens, with a summary and Manage dialog on smaller/shorter screens. Statement
totals are compact, and month navigation, details and export stay visible.
Styles are scoped to the active FirstMeasure-only pane. Combined platform
billing and other settings pages retain their existing layout.

Candidate and deployed browser checks passed at 1440×900, 1366×768, 1280×720,
900×900 and 390×844. At each size, the outer settings card and app panel had
zero vertical overflow, the statement stayed within the viewport, and history
could scroll independently. Checks included enabled top-up controls, the compact
dialog, switching to a populated month, visible statement action buttons and
absence of JavaScript page errors. Screenshots were inspected. The write adapter
was stubbed for control checks; the saved account remains auto-top-up disabled,
with its original $50 threshold and $100 amount. Temporary sessions were revoked.

Only scoped company-settings changes and its bundle cache token were deployed.
The release preserves web/pool baseline `2c233eae103e3fcb62d0ab3b6299f4d5a6979ac0`
and compatibility baseline `3dc59abd3edadbc211ba3e00433d377bb943b1d3`.
All three hosts verified syntax, source hashes, process identity, readiness and
enforced development outbound isolation. The worker was unchanged.

After load-balancer readmission, 24 public readiness requests reached both
instances: 13 to `do-598520065`, 11 to `do-603124965`. Both public asset hashes
matched the deployed release. The historical autoscale-image limitation remains;
no image, topology or production changes were made.
