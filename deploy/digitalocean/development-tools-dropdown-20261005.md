# Compact development dropdown and generation amounts — October 5, 2026

UI and amount commit `e1abe2674f95640df6e0b54974fbdfce9fc74280`; final release
`1ce03699e5ae4e6bf883c98a2230ec1684b929b4` adds distinct synthetic contact emails.
Development only.

The code control now owns one anchored dropdown directly below the header, aligned
to the right edge. There is no separate hover preview or floating window. Clicking
the code control again, Close, outside the panel, or Escape hides the entire panel.
Desktop hover opens the same panel after a brief delay; close suppresses immediate
reopening. Mobile uses the existing More menu and the same anchored panel.

Removed the introductory heading, subtitle, per-category descriptions and extra
helper copy. The eight switches use two columns. Company type and Amount share
the top row. Amount offers 1x, 3x, 5x and 10x fixture batches per click.

Each UI request supplies a UUID retained for retries. AsyncLocalStorage scopes
fixture IDs and channel keys/names by request and batch, preserving cross-category
relationships without mutable global state. Subsequent successful clicks receive
new UUIDs and add new samples. Shared document templates remain shared; projects,
drafts, lists and other instance data scale with the amount. Contact emails include a stable batch suffix so the Contacts UI does not collapse
separate samples. The API bounds amount
to integer 1–10. Calls without a request UUID retain legacy idempotent behavior.

## Verification

Focused backend tests cover scaled all-category generation, 3x event counts,
new-batch addition, retry deduplication and invalid amount rejection. Browser
verification checks the exact header offset, absence of duplicate popup elements,
two columns, selection payload, close/reopen, outside dismissal, Escape and mobile
access. Evidence is under `output/development-tools-amount-20261005`.

Whole-workspace TypeScript validation encountered unrelated concurrent changes in
`integrations/jobs.ts` and `tests/property-market-pricing.test.ts`. Immutable Linux
payloads are independently typechecked before activation. Only task-owned files
are overlaid, and development environment/readiness checks remain enforced.
Previous per-role paths and hashes in the output manifest provide rollback inputs;
verify current active state before rolling back because other development releases
may have subsequently retained this change.

## Hosted result

The deployed browser test passed desktop and mobile layout, button toggling,
Close, Escape, outside dismissal and delayed hover using a single panel.
A 3x request in the development test organization completed all eight categories:
12 projects, 15 contacts, 18 events, 30 equipment units, 12 material lists,
12 draft estimates, 12 channels, 9 inbox examples and 36 channel replies.
Shared templates were reused. No outbound transports or signatures were invoked.
