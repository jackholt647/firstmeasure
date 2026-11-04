# Production hotfix f3789644: full-house submit without a claim, November 4, 2026

Released on Jack's request ("Go ahead and hotfix the full-house claim message to prod."). Run from this PC through fm-agents-1.

It is production-live `dda68284` (release `9f0d10c6`, FM-324) plus one commit on `hotfix/fh-submit-unclaimed-20261104`: `f3789644`, cherry-picked unchanged from canonical `f6a4802b` (on dev as `platform-20261104023555-6188ce93`).

## Change

- **Full-house submit without a claim** (Maynard, `exteriors_6e0db661…`, 2301 19th Ave S, Seattle). The order was Ready and unassigned; Maynard opened it straight in the editor and submitted. `updateStatusForSubmission` checked the full-house qualification of the assigned drafter, found nobody, and answered "This technician is not enabled to draft full-house reports." He then claimed it from the queue (02:19 UTC) and submitted (02:23 UTC); it is in QA. An unclaimed full-house submission now answers `full_house_claim_required`: "Claim this project from the queue before submitting it." Qualification checks are unchanged. The project was not touched.

## Checks before release

- `tests/full-house-workflow.test.ts` (new unclaimed case) and `tests/firstmeasure-submission-status.test.ts` 2/2 on the commit.
- Build on the dev worker: archive sha256 `4326a410d335c8740311564b676f4c56e33caf67c10f8b30b1cc1ded223605d1`, verified there, on compatibility and on the worker.

## Rollout

- Tracker bug-fix router stopped at 02:38 UTC with nothing in flight (FM-324's production rollout had finished at 01:20:50).
- Compatibility 02:48:42 UTC from `9f0d10c6`: ready on `f3789644`.
- Worker at 02:48:52 UTC after no running jobs: 8 slots, production, heartbeat off.
- Signed channel published against `b7a7625c…` (9f0d10c6's archive) from the release's real path; a web node downloads `f3789644` / `4326a410`.
- Six web nodes one at a time behind the load balancer, 02:50:20–03:03:50 UTC, each back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `f3789644` on 12 of 12 requests; all eight hosts point `current` at `f3789644`, and each host's built `api.js` carries `full_house_claim_required`.
- Tracker router started again after this record was pushed.

Rollback target: `9f0d10c6`.
