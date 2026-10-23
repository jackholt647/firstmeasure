# Development rollout: presentation Accept & sign, portal preview, one send path (October 23, 2026)

Release `dd017b862a12530d1ffbff636554d49a3a7f629f` on the canonical branch
`codex/consolidated-firstmeasure-20260923` (session branch
`claude/presentation-sign-send-b9566d`). Development only; no production change.

## What changed

- **Accept & sign in a presentation.** It did nothing: it sent the contract with
  no signer, so a project without a contact was refused (400) behind the
  full-screen presentation, and the choices it had already written left every
  later send stale (409, `module_revision`). Now the presenter names the signer
  and attests that they witness it; the agreement is issued with no invitation
  email; the customer signs on screen with the retained review PDF on the left
  and the one consent checkbox (disclosure inline) and Adopt & sign on the right
  (`doc-present/firstmate-present-signing.js`). Signing runs on a new documents
  presenter route (`/documents/organizations/:org/documents/:doc/signing/present/*`,
  `issue_documents`, evidence `presenter_witnessed_in_person`). The executed copy
  is sealed, timestamped, put in the ledger and emailed by the outbox.
- **Open what they see** opens the portal's preview of the document
  (`preview_url` on the send result). The preview payload carries read-only
  document links (`documents/preview-links.ts`); every public write route refuses
  them with `portal_preview_read_only`, and the portal cannot get signing access in
  preview. The preview banner says nothing can be signed, accepted or paid.
- **One send path.** The presentation's Send my estimate and the workflow's Send
  call one client function and show the same failure and undelivered-email wording.
  A presentation send checks its signer before writing choices. Email presentation
  link names the customer (it named no one, so nobody was emailed).
- **Email default.** Every organization sends customer email from its own
  `<slug>@firstmatemail.com` FirstMate Mail identity, provisioned on first send
  (`email/engine.ts`), so "no email set up" does not happen; dev runs that lane in
  capture mode (`EMAIL_DELIVERY_MODE` unset), which records sends without delivery.

## Rollout

- Roles: worker, legacy (compatibility) and web. **Pool was unreachable** ("No route
  to host" through the web jump host), as for the October 22 sibling rollouts, and
  was not updated.
- Live `documents/service.ts` on all three roles was the `0655b0a9` version (the
  document history and edit-as-sent changes to it were committed but not live), so
  this release's three edits to it were replayed onto the live file
  (`output/presentation-sign-send-20261023/service_edits.py`); every other file
  merged three ways.
- Staging was retried several times because other sessions activated releases
  between audit and stage; `ship.sh` now waits for quiet before each audit.
  Web's first activation stopped at its pre-activation health check (503 while
  another rollout restarted web) and was activated alone once healthy.
  `rollout.py verify` passed on all three roles at `dd017b86`. Later releases by
  other sessions (`5bd18dc2` on web and legacy) carry these files forward; checked
  on the hosts.
- The shared checkout's `documents/project.js` held a stale uncommitted rewrite of
  the same Accept & sign function (Documents session, October 16, crew presenter
  route). It was superseded by this release; the diff is kept in the side-session
  notes (`presentation-sign-send-preintegrate-unstaged.diff`).

## Verified on dev.1m8.ai (built-in browser, sandbox org `org_0be79c9db0e60b5a`, project without contacts)

1. Present a roofing proposal, last slide, **Accept & sign**: "Who is signing?"
   (refuses without the witness box), then the contract (2 pages) beside consent,
   name, Type/Draw and Adopt & sign. Disclosure opens over the contract without
   ticking the box; Adopt & sign without consent says so. Signed: the evidence
   shows `presenter_witnessed_in_person`, the presenter's user id, consent with the
   disclosure hash and `presenter_witnessed: true`; ledger `receipt, executed,
   sealed` (check ok); seal by the development certificate with an outside
   timestamp; executed copy (3 pages) shown on the left and delivered after the seal.
2. **Send it to me instead** from a presentation: sent (200), presentation frozen.
3. Workflow end **Send**: "Sent to Pat Homeowner", Emailed. Both places behave the same.
4. The eye button opens `customer_portal/preview.php?id=<preview>&document=<id>`
   (no signing credential) with the preview banner. Every document link in the
   preview payload is `preview_…`; reading works; outputs, signing prepare, view and
   payment checkout return 403 `portal_preview_read_only`; signing access 403. A
   choice clicked in the preview shows the preview message and nothing is saved
   (no outputs, not marked viewed).

Not verified: delivery to a real inbox (dev records email in capture mode).

## Tests

`tests/document-presented-signing.test.ts` (new), `publication-presentations`,
`document-signing`, `document-seal`, `portal-signing-access`,
`customer-portal-writes`, `customer-portal-v2` pass; `npm run check` passes.
`document-signing-ui` ("signature modal requires PDF access and consent") times out;
this release does not change the signature widget it tests, and a fix for that test
sits uncommitted in the shared checkout from another session.

## Follow-up releases (October 23): preview selections and the sign slide

- `f299f93b`: in a portal preview the workflow renders read-only, the portal
  refuses a choice before changing anything locally, and the rendered document's
  controls are stopped with the preview message. On the presentation's sign card
  the recap rows are taller and the chosen option spans the row; a name still too
  long ends in an ellipsis with the full name as its tooltip and accessible label.
  Deck revision 7.
- `c38eeb44`: a current roofing template now also refreshes its deck preset, so a
  deck revision reaches existing organizations without re-seeding the whole
  roofing pack (an organization's edited deck is kept).
- Both on worker, legacy and web (`rollout.py verify` passed); pool still
  unreachable.

Verified on dev: clicking another shingle in the preview leaves the selection as
it was (cards disabled, preview banner); the sandbox org's three roofing decks
moved to revision 7 on its next document seed; on the sign slide each chosen
option sits on one line within its row (284pt wide), and a long name ends in an
ellipsis with the full name in the tooltip.
