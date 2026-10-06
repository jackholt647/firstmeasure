# Company Settings pane visibility — October 6, 2026

Source commit: `25c3a77d37882d2f5259c0dccd83eb8c451b3dbd`.

The shared price-book editor adds `pb-embed` to its mounting container and
injects a later `display:flex` rule. Company Settings mounted it directly on
its tab pane. After removing that pane's active class, the later library rule
overrode Settings' `display:none`, so the inactive price book occupied space
above subsequently selected sections. Settings now enforces hidden inactive
panes regardless of injected layout styles. Active panes retain their own
layout and embedded content stays mounted. The company bundle version advances
to `20261006-pane-visibility-v1`.

The browser regression mounts the actual price-book library, uses Settings'
pane selection code, and checks repeated transitions to Company and Money and
back to Pricebook at desktop/mobile widths. It verifies one visible pane,
pointer access and retained price-book nodes. The previous source fails with
two visible panes; the fixed source passes. All seven focused Settings and
price-book checks pass.

Only the Settings asset and manifest version are overlaid onto independently
audited development serving baselines. Unrelated workspace and role-specific
manifest changes are preserved. All three serving roles activated the scoped
commit and passed runtime identity, isolation and source-hash checks. No worker,
backend, migration or production activation is included. The prior immutable
release paths in `output/settings-pane-visibility-20261006/manifest.json` are
retained for rollback through the normal sequential development activation
workflow after inspecting intervening changes.

Hosted verification on dev.1m8.ai used a disposable Instant Full Org. Repeated
switches among Company, Money, Contacts and Pricebook at 1440px and 600px showed
exactly one visible pane and hid Pricebook whenever another section was selected.
Available Company, Money and Pricebook controls passed pointer hit checks.
Desktop/mobile screenshots were inspected; no browser page errors occurred.
Public asset hashes and readiness passed, and the temporary organization was
deleted. Receipts are under `output/settings-pane-visibility-20261006/`.
