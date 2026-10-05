# Connections layout and hover — October 5, 2026

Final development release: `bc4ba671a3cb0272e7b93971cfd6c122a608bf5a`.
The cumulative change is in commits `86826c53`, `428a27a8` and `bc4ba671`.

Primary buttons retain their colored background and visible white text on hover.
The setup assistant starts at the top of a full-height workspace column. Connection
instructions and chat messages scroll independently; the composer stays visible.
Settings' outer card padding and empty status spacing no longer push the assistant
down the page. Embedded assistant autofocus preserves the surrounding scroll
position. Settings pane visibility remains intact when changing tabs.

The desktop/mobile native browser fixture passes locally and with JavaScript
fetched from dev.1m8.ai. It exercises both primary hover buttons, the real shared
chat renderer and credential form, Settings' active-pane CSS, long connection
instructions, independent scrolling, composer visibility, page scroll position,
tab hiding/restoration, and mobile overflow. The hosted check also asserts that
the mobile composer remains inside the viewport. Public source hashes match the
payloads, and six readiness samples reached both updated web instances with
development isolation and outbound safeguards enforced.

Only two frontend assets are overlaid on audited serving baselines. No backend,
database, credential configuration or worker changes belong to this UI rollout.
Concurrent updates were preserved through source/process guards. All serving
roles use the existing immutable hardlink staging and sequential activation
workflow. Production is unchanged.

Evidence, source snapshots, manifests, receipts and desktop/mobile screenshots
are in ignored `output/connections-layout-verified-20261005/`. Earlier staging
evidence is retained in the two `connections-layout*` sibling directories.

Rollback: inspect intervening releases first. The last baseline before this UI
work was `e38288238b5bf7c60d69702d0baa19b53182fae2` on all three serving roles.
Retain that baseline for rollback rather than the intermediate layout candidates
`86826c53` or `428a27a8`. Restore its role-specific path, restart the development
service and reload PHP-FPM; verify local/public readiness and isolation one web
node at a time. No data rollback is required.
