# Custom fields UI redesign — September 26, 2026

Deployed to `https://dev.1m8.ai` on both development web nodes.

Organization, project and contact scopes now use compact tabs and one Add field button. Organization values and definitions share the same view; saved values are prominent and field settings are expandable. Empty organizations retain a usable Add field action. Type selection is a compact dropdown, buttons have explicit consistent typography and 36px height, and the editor adapts to narrow screens.

The settings shell previously hid and automatically invoked custom-field Save buttons. The editor now opts out with `data-settings-autosave="off"`. Preview controls receive the shared editor CSS and cannot accidentally block definition submission. Organization editors load all authorized fields, including background fields, respect writable access, and display errors with a retry action.

Source commit: `e2205cb9a8006ea8b3a3d4313bd5d6c5ae5934e2` on `codex/custom-fields-ui`.

| Role | Previous | Release |
| --- | --- | --- |
| web | `3b7afcf91e8878226135c6a67de68fdd15454ff3` | `07146b6285911bfef4500fb863a6fbac44935f59` |
| pool | `ce2a4c9aa00d1f66636199fe692bee7c3ad3a705` | `e55450cc595582bb595e9054279178b6dc304a66` |

Verification: JavaScript syntax check and seven browser/UI contract tests passed. Authenticated tests in the real portal created an organization email field, saved its value, and reloaded it from the deployed asset. Desktop and 390px mobile screenshots were inspected; the visible action buttons measured 36px and the page had no horizontal overflow. Both services passed readiness, development outbound safety, source hashing, and publication catalog checks. The disposable organization, identity, session and action receipts were removed.

Only the custom-field browser asset changed in runtime releases. Existing live source changes were preserved with three-way merges. No database or production change was made. Rollback targets are the previous role releases above; the existing autoscale-image limitation is unchanged.

Evidence: `output/custom-fields-ui/` and `public/v1/.tmp/custom-fields/`.
