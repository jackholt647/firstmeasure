# Contacts store, lead intake, opportunities and merge — development

Source releases: `1c9312523184e09363f92423cb55e73f82ec9b11`, then
`792ecbe95b8a4a7cb7a7ce0e9ed1e2fc6aa2c50e` (contact ids may contain `.` and `:`).
Branch: `claude/contacts-opportunities-20261015`, started from canonical
`80aa8f40`. **These release commits are not on the canonical branch**; they
must be merged into `codex/consolidated-firstmeasure-20260923` before any
production release.
Target: https://dev.1m8.ai; user-authorized development rollout only.

## What shipped

- Contacts are records of their own in the `contacts` store; `project.contacts`
  is a projection, and project writes that still send contacts go through the
  contact service ([contacts](../../docs/architecture/contacts.md)).
- Every lead source calls `receiveLead`; leads never rewrite existing contacts
  ([opportunities](../../docs/architecture/opportunities.md)).
- Scope categories with a built-in `sales` category replace scope `kind`;
  sales plans carry a won/lost outcome set by `sales.markWon/markLost/reopen`.
- Contact and project merge, duplicate suggestions, reference adapters.
- The legacy CRM (old sales portal, lead database, lead/dialer/import routes,
  generic CRM document routes) is gone; call lists live in `comms`, routes at
  `/v1/call-lists`. Referral routes remain at `/v1/internal/crm/referrals` and
  still check no login (audit SEC-1, left for the user to decide).

## How it was deployed

Per-file three-way merge onto each role's live copy, base `80aa8f40` for the
first release and `1c931252` for the follow-up. Hosts had moved on unevenly:
the worker's contacts files were the 2026-09-29 version, so the worker got this
release's full copies of `contacts/contracts.ts`, `publication.ts`,
`service.ts` and `platform/storage.ts`; `permission-bundles.ts` and
`widgets/objects.ts` had this release's exact edits replayed onto the live
text; `tests/contact-imports.test.ts` was left as each host had it. Bundle
versions bumped to `20261015-contacts-store-v1`. Scripts:
`output/contacts-crm-20261015/` in the worktree.

`deploy.py` was extended to remove declared files from the **staged copy**
before the host TypeScript check: this release's deleted and renamed files
(`internal/crm/{leads,migration,storage,call_lists,platform_call_list_api}.ts`,
`CALL_LISTS.md`, the 47 files of `public/measure/sales`) and
`lead-intake/api.ts`, which was deleted from the repository in `0562254e` but
still sat on the hosts and imports the removed `createPlatformLead`. The
current release directory is never modified. Two half-staged directories from
a failed first attempt were renamed `…-failed-stage-1/2` on the worker, not
deleted.

## Migration and checks

`migrate-dev.mjs` on the web host (service environment, development only):
5,810 organizations, 18,143 projects linked, 17,862 contacts created; 3
organizations first failed on `project_x:contact:0` ids and succeeded after the
follow-up release. The read-only check afterwards found 18,113 contacts, 18,321
projects with contacts and **0 projects whose contact list differs from its
links**; 585 sales plans (583 open, 2 won).

Before deploying: the full suite on a frozen copy of the release against the
same files on the unmodified base found two failures new to the release (a
published-action count, fixed; a Windows file-lock cleanup error in
`internal-teams`, unrelated). `channels-agent.test.ts` hung on both trees and
was stopped. The new contact, lead, opportunity and merge tests pass on SQLite
and PostgreSQL. Host TypeScript checks passed on all four roles; every role
verified healthy after activation. The browser UI was not exercised against dev.
