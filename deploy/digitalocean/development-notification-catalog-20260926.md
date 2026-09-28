# Development notification catalog — September 26, 2026

Source: `68c286d` on `codex/consolidated-firstmeasure-20260923`.

The shared catalog exposes 113 registered Work event subscriptions, existing direct
app notification preferences, and declared scope notifications. Event subscriptions
require no scope rule and start off; existing notification defaults are preserved.
Scope categories include empty/archived templates and alerts from active pinned
versions. Custom scope code supplies a declared notification ID. Preferences remain
separate from workflow execution. See [the contract](../../docs/architecture/notifications.md).

Settings now provides Apps and Workflows & scopes views, search across both,
collapsible full-width categories, 1–3 compact columns, info tooltips and switches.
Preference writes are serialized with explicit retry after failure.

Runtime deltas preserve each complete inventoried live baseline, plus all unrelated
mobile, language, assistant and exterior changes. Immutable role commits:

| Role | Previous | New |
|---|---|---|
| Web | `af9c9e726d8f211e1541d11382460e13789ae177` | `7bd510408edaa0851d09dd492c28e5eea61c7aee` |
| Pool | `af9c9e726d8f211e1541d11382460e13789ae177` | `21e81ae9d156e348faadf417632865f3bea6ad4a` |
| Worker | `b325f01c499393cbc4aaa298c67964dfdc71820a` | `b106df96608c0a36850e2f6564c3307bdb811af5` |
| Compatibility | `c5768e62b39b366a6dfddccfd7d3e742c4d8e510` | `998dac1913322c0c6b547e776eb99ff55e329f45` |

Verification includes TypeScript checks, all four role source builds, 21 focused
notification/automation/artifact tests, browser checks for responsive columns,
search, collapse, empty scopes, keyboard use, rapid toggle changes and failed-save
retry. Staging on all four Linux roles successfully imports the 113-event catalog.
The publication suite has 46 passing tests, one PostgreSQL skip and one existing
unrelated failure: the Assistant app is listed in ownership coverage but absent
from the current app directories. This also fails in the canonical source checkout.

No app flags, tester preferences, native provider credentials or APKs are changed.
Actual native push still requires Firebase/APNs setup. Production is unchanged.

All four roles activated and passed readiness, development isolation, compiled
catalog import and changed-file hash verification. Authenticated live browser checks
passed on desktop and mobile with zero page errors. The tester remains
Measurements-only under its existing app flags (five types, ten switches), and live
search correctly narrows those types. No tester preferences were mutated. The
temporary verification session was revoked after the browser check.
