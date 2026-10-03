# Development appointment presets and department scheduling — October 3, 2026

Source release: `f552a8219a9b2e4a8da5e198f480f469dabf6ca9` on the canonical branch. Development only; no production activation.

## Behavior

- Project Schedule removes its sidebar and uses one + Appointment button, opening the shared booking widget with the project fixed.
- Custom appointments allow no project, no department, multiple departments, delivery and finite recurrence independently.
- Branch catalogs contain configurable departments, department groups and reusable configuration presets. Sales and Production are defaults. Advanced edits become Custom; named-resource presets ask for assignment before availability.
- Staffing supports people/crews, minimum counts, all, percentages, named resources and optional crew roster percentages. Every recurrence is checked and reserves the same team/local time.
- Duration is reserved inside a separately stored customer arrival window. Delivery remains a flag without material-list effects.
- Calendar filters use department data, retaining legacy event classification. Custom departments have resource lanes; existing Sales/Production routing tools remain.

See [appointment planning architecture](../../docs/architecture/appointment-planning.md) for contracts and concurrency boundaries. Recurrence is 2–52 occurrences within two years.

## Validation and deployment

Five planning/booking tests and four browser tests pass. Publication tests: 50 pass, one gated PostgreSQL test skipped. Local TypeScript passed. Scheduling UI contracts: 62 pass, the same 14 pre-existing localization/formatting assertions fail.

Payloads retain each role's live baseline and apply only owned changes. The project-request file includes only removal of Schedule from sidebar ownership; unrelated workspace edits are excluded. The legacy schedule-panel merge removes its obsolete sidebar while retaining other live code. Staging checks source hashes, JavaScript syntax, compiled parity and Linux TypeScript on every role.

All four roles passed staging, activation, hash/readiness and outbound-isolation verification on `f552a8219a9b2e4a8da5e198f480f469dabf6ca9`. The previous active release was `11fe8fc5bc9596dd745c684b252cac7678e65565` on every role. Rollback uses each manifest `previous_path`, followed by restarting its development service.

Hosted browser verification passed presets-to-Custom behavior, independent department/delivery/recurrence controls, standalone and two-occurrence PostgreSQL bookings, stored 60-minute duration inside a 240-minute arrival window, the project-frame creation button and locked project selection, and mobile bounds. Browser errors: zero. Desktop, mobile and project screenshots were inspected. Temporary one-off bookings were deleted and recurring test series cancelled in the development sandbox. The initial project-button test targeted the parent page; correcting it to the existing project iframe passed without a product change. Evidence: `output/appointment-presets-20261003/`.
