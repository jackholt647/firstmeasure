# Development automation fixes — October 6, 2026

Code release: `3468a77f8c1009cf2693dd3f0f05d12dc2734b07` on `codex/consolidated-firstmeasure-20260923`.
Live on the web, pool and compatibility roles of `https://dev.1m8.ai`.
**The worker role is still on `758abe21`**: staging was refused because its disk
has 2.5 GiB free and the deploy guard requires 3 GiB. The two engine fixes below
take effect on development only once the worker is updated.

## Changes

- A saved `proposal.signed` subscription now matches a proposal signed through
  Documents (`document.signed` with `document_type: "proposal"` or a `proposal`
  tag), as well as the retired proposal link. Before this, a Documents signature
  started production scopes but left the sales pipeline's contact, proposal and
  signature steps open.
- Action input templates resolve list positions, so
  `{{project.contacts.0.phone}}` returns the first contact's phone.
- The action catalog and its examples use those contact templates again.
- Nine stale tests in `automation-engine` and `work-api` enable the opt-in
  Notifications app in their fixture. The notify action was working; a fresh
  test organization has the app off, so every delivery was cancelled.

## Validation

On a clean tree of the release: `npm run check` passes, and 89 of 89 tests pass
across `automation-contracts` (twelve, two new), `automation-engine`, `work-api`,
`scope-event-map`, `scope-artifacts`, `scope-agent`, `project-scopes-routing`,
`kitchen-remodel`, `publication-scope-code`, `document-signing` and
`documents-api`.

Still failing, unchanged: the `proposals-api` lifecycle test signs through the
proposal link that document signing retired (`proposal_signature_reissue_required`).
Its later assertions cover `startWorkPlansForSignedProposal`, which no supported
path reaches now; it needs a decision from the document-signing work, not a fix here.

## Rollout

Parent `758abe21` on all four roles with no drift. Web staged; the worker stage
then failed its free-space guard. The rollout command did not stop on that
failure and activated web alone, leaving the roles mixed for a few minutes.
Compatibility and pool were then staged and activated. Web, pool and
compatibility report `3468a77f`, ready and development-isolated; public
readiness returns `3468a77f` consistently.

To finish: free space under `/opt/firstmeasure/releases` on the worker (about
290 retained releases of roughly 780 MB each), then run
`python output/automation-fixes-20261006/rollout.py stage worker` and
`... activate worker`. Any later release rolls these changes onto the worker too.
