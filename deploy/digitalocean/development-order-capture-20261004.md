# Development report capture and submission â€” October 4, 2026

Release: `05dc46411c5facb4a7d78cbfc8f09d2cfa0a8783`.

Full Structure no longer synthesizes a Photos project tab. Its desktop reference workspace stays inside Overview; mobile capture uses the remaining viewport, without the Overview divider. The closed-hours notice is confined to the map step.

Report submission immediately shows Ordering, makes the form inert, disables Back/close/navigation, preserves the current page during preflight and coalesces repeated submissions into one in-flight promise. Failure restores controls. Credit top-up handoff remains available. This is client in-flight deduplication, not a new server idempotency contract.

Validation: 34 capture, upload, order-draft, development-order and submission tests passed; another 9 layout/submission and Overview workflow checks passed. Camera layout covered 390Ã—844, 412Ã—915 and 700Ã—500, with a fake live camera and Android capability emulation. Physical Android camera behavior has not been device-tested.

Deployment: applied only the three frontend files as an immutable overlay to freshly inventoried dev web, compatibility and pool sources. Syntax, source hashes, process release, readiness and development isolation passed. Worker and production were not changed. The compatibility merge preserved its existing close behavior while adding the submission guard.

## Rollback baselines

- web: `/opt/firstmeasure/releases/33320dc9bd6034f6074040fb160f04dbb26cd898`
- legacy: `/opt/firstmeasure/releases-root-archive/33320dc9bd6034f6074040fb160f04dbb26cd898`
- pool: `/opt/firstmeasure/releases/33320dc9bd6034f6074040fb160f04dbb26cd898`
