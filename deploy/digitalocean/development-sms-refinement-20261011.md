# SMS workflow refinement — October 11, 2026

Fixes number-search state loss when clearing/deleting digits or receiving results.
Keeps the current preview and chooser open; revision checks ignore stale async
responses and selection cancels pending searches. Moves the change-number link
to the selected-number header and removes the choice badge and extra description.

Consent cards use compact icon-free choices. New drafts default to all three
purposes; saved selections remain unchanged. Removes the separate feature
confirmation from UI and server validation, retains final application consent.
Supporting evidence is always expanded, optional, with aligned upload/link inputs.
Removes repeated example disclaimer. New message sample fields remain empty;
expandable examples appear below them. Existing saved samples are preserved.
Campaign description remains required by Telnyx and is now clearly labeled.
START/STOP/HELP copy is sent in campaign payloads and provisioned as autoresponses.

Validation: four browser tests, including short/empty number searches, delayed
response races, preview switching without purchasing, empty message fields,
retained edits, evidence upload, mobile layouts, and automatic status refresh.
Focused API workflow verifies drafts/provider payloads with featuresConfirmed
false. Browser suite also passes on merged current dev source. Desktop/mobile
layout screenshots reviewed. No real purchases or carrier submissions in tests.

Provider reference:
https://support-v2.telnyx.com/en/articles/6339152-how-to-create-a-10dlc-campaign

Deployment: guarded per-host overlays preserving concurrent dev changes.

## Development verification

Activated `aff4d7de8fa25cd0e7085b0ff6bc607a96301451` on web, pool,
compatibility and worker; each HTTP role returned ready and worker was active.
A concurrent download release then restarted services, temporarily returning
public 503s. Verified that its web source retains exactly the SMS frontend/API
payload hashes. Public readiness subsequently returned ready and the public
company.js hash matches this rollout: `78eae25103db1d219e0f8145c4cbd9a7b95266512dce607c37383b491b166e31`.
Concurrent restarts can still produce transient legacy-service warnings. No
production activation or real number purchase was performed.
