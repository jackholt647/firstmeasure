# Contact window handoff and tab insets — October 5, 2026

Commit `18a1cbd4f80643c906a5655822409378ff4db630` fixes project title dropdown
→ primary contact → View Contact. The retained project iframe formerly closed
itself before trying an optional Contacts module in its own document. The window
bridge now validates the calling child, lazily loads Contacts in the owning
portal, awaits its open, and then closes the source project. Failures keep the
project available and show feedback. Split project panes forward through their
own validated bridge. The contact-context return action uses the same handoff.

Contact local panes own a consistent 18px desktop / 12px mobile content inset.
Projects and Photos & Media render inside that inset, with gallery padding
removed to avoid doubling it. This is the default for subsequent contact pane
content too. Project tab resource isolation and contact persistent-sidebar
ownership remain as documented in the shared entity-window architecture.

The focused browser test covers lazy loading, contact identity, parent ownership,
successful source close, foreign-child rejection, failure preservation, and
desktop/mobile single and split-pane insets. It passes. Existing window shell
and contact shortcut checks pass. One broader identity-popover browser assertion
about shortcut visibility fails in concurrently maintained header code; this
release does not change that renderer or those shortcut styles.

Only five frontend files are overlaid onto each audited development web and
compatibility baseline. Bundle versions were advanced for reloads. Scoped Git
content excludes unrelated local project and manifest edits. The worker has no
changed runtime files and is excluded from activation. Baseline guards stopped
stale staging/activation during concurrent development rollouts; new audits and
immutable overlays preserve those releases. Prior paths, source hashes, and
artifact receipts are in `output/contact-window-handoff-20261005/manifest.json`.

Rollback uses the retained prior paths with sequential development activation
and readiness checks. Production is outside this rollout.

## Hosted verification

Both web roles and compatibility activated the scoped release. A subsequent
concurrent release changed the first web node to
`0ed4fb7cfca333795dc1eaab6df76fbc5e301c13`; the final read-only audit confirmed
all five task payload hashes remain exactly preserved there. Compatibility and
the second serving node were verified on
`18a1cbd4f80643c906a5655822409378ff4db630`. Runtime release identity and
development isolation passed; public assets match the scoped payloads.

A fresh hosted sandbox created a disposable project with a primary contact.
The actual title dropdown and View Contact menu opened that contact in the
outer portal, then removed the retained project window. Photos & Media had an
18px top inset at 1440px and 12px at 600px, without document overflow. Both
single and split-pane layouts passed, with no browser page errors. Desktop and
mobile screenshots were inspected. The temporary organization and identity
were removed. Evidence is under `output/contact-window-handoff-20261005/`.
