# Pioneer Puffin Communications call examples — October 8, 2026

Development only: `dev.1m8.ai`, sandbox organization `org_983c8e17cd313149`. No production data, call transport, recording, or provider configuration was changed.

## History repair

The authenticated History view returned `500 calls_error` for `GET /v1/comms/organizations/org_983c8e17cd313149/calls?limit=50`. The deployed department-aware call query referenced `customer_call_departments`, but the development PostgreSQL database did not have that table. The Communications SQL store was already marked at schema version 1, so the newer additive schema initializer did not rerun on deployment.

The guarded script `public/v1/scripts/repair-call-departments-schema.mjs` created the missing table and index on development. It verified that the table was absent before the repair and present afterward. The source initializer now declares the same table and raises the Communications schema version to 2 for existing installations. The currently served development release was not replaced: it contains newer concurrent Communications work, and the data repair alone restored History. The next release that includes this source change will rerun the additive Communications schema initializer.

## Synthetic data

`public/v1/scripts/seed-pioneer-puffin-calls-20261008.mjs` added 7 external call records, 5 published scripts, 6 scheduled call follow-ups, 3 call lists, and 8 pending list entries. Records link to existing synthetic project contacts and staff. Calls span answered inbound and outbound conversations, a voicemail, and a busy attempt. They include outcome, timed attempt, owner, purpose, summarized notes, and an immutable snapshot of the sample script shown in the call detail; no audio or invented recording is attached. All customer numbers are reserved `202-555-01xx` examples, and the script checks the exact Pioneer Puffin sandbox and the development data environment. Its dry run found 29 expected writes before application and zero writes afterward.

The calls and their notes correspond to existing two-way SMS, email, and portal conversations where applicable. Follow-ups are scheduled October 9–12 in `America/New_York` and assigned to the sample teammates. Published scripts cover new inquiries, estimate review, installation access, post-install quality checks, and voicemail callbacks. Lists hold separate pending customers for estimate and insurance decisions, access checks, and quality checks; they do not present already completed calls as pending entries.

## Verification

- `npm run check` passed.
- `npm run test:customer-calls` passed: 36 tests.
- Hosted browser verification showed History, a call's saved notes and script, all six follow-ups, the three populated lists, and all five scripts with no data-view request or page errors. Screenshots and the local verification harness are in ignored `output/communications-20261008/`.
- The public development History request returned 200 after repair. An initial 503 on sandbox login was transient; retry succeeded. The phone tray attempted an endpoint token while displaying a saved call and received a 409 once; this did not affect the data views or saved notes.

Rollback of the examples: remove only records tagged with `pioneer_puffin_calls_20261008` after reviewing any later edits to those records. The additive table should remain, because the active department-aware call query requires it. Production activation follows the usual separate release process.
