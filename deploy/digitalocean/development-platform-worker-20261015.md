# Development platform automation worker — 15–16 October 2026

Approved by Jack on 15 October 2026. Development only.

## Why

Signing the Test Johnson roofing document (`doc_3ce64caadb054f248b6d`, project
`project_mv8cc316_wtzu6h6b`, organization `org_33fbee0f9c7d6823`) started no
`roof_replacement` production plan. The `document.signed` work event was
recorded correctly, but nothing processed it.

Development runs as a cluster (`DEPLOYMENT_TOPOLOGY=cluster`). There, only a
process with `PLATFORM_PROCESS_ROLE=worker` drains the work event queue
(`platform/runtime.ts`), and that process is `dist/src/platform_worker.js`. No
development node ran it; the worker Droplet ran only the FirstMeasure report job
worker (`firstmeasure_worker.js`). This was noted on 26 September
(development-assistant-agents-20260926.md) and never set up.

As a result, no automation had ever run on development:

- 6,099 work events were pending, going back to 24 September;
- the automation execution table was empty;
- notification delivery, the payroll outbox, scheduled messages, agent jobs and
  appointment confirmations had never run either.

## What was done

1. `deploy/digitalocean/firstmeasure-development-platform-worker.service` was
   installed on the worker Droplet (137.184.44.82) and enabled. It uses the same
   environment files as `firstmeasure-development-worker.service`, so both see
   the same data environment, with `FIRSTMEASURE_JOB_WORKERS=0` and
   `ExecStart … dist/src/platform_worker.js`.
2. Before it first started, the backlog was skipped rather than replayed:
   - every `pending` or `failed` work event created before
     2026-10-16T00:01:37.236Z was set to `status='skipped'`, with the reason in
     `error` (6,101 events). Nothing was deleted.
   - No notification delivery was pending (they were suppressed, cancelled or
     already available), so none was cancelled, and nothing old was sent.
   - Only the Test Johnson `document.signed` event
     (`work_event_1ea8e67c77ce4e59bd032e150bbe10da`) was put back to `pending`.
3. Started at 2026-10-16T00:01:5x. The re-queued signing ran:
   `documents.dispatchOnSigned.v1` → `scopes.activateFromProposal.v1` activated
   `roof_replacement` (plan `work_plan_5a11215173a250e14f768b4c`, source
   `document_signed`), and `payments.ensureReceivables.v1` confirmed the payment
   schedule.

## A fix it exposed

Once running, `notification-delivery` failed on every tick with
`background_author_unavailable`. Turning a notification into recipients read
each audience member's preferences through `backgroundAuthContext`. That throws
for a user with no active account, such as a sample person. The throw aborted
the whole drain on the same occurrence every time, blocking every notification
for every organization.

`platform/notifications/delivery.ts` now skips such a user: they cannot be
notified, and everyone else still is. The default recipient plan falls back to
the notification's baseline when a recipient's preferences cannot be read.
There is a test in `tests/notification-runtime.test.ts` ("a user with no account
in the audience…"); it fails without the fix with this same error.

Five tests in `notification-permissions.test.ts` fail before and after this
change; they are unrelated.

## Operating it

- Status and logs: `systemctl status firstmeasure-development-platform-worker`
  and `journalctl -u firstmeasure-development-platform-worker`.
- Releases activate under `/opt/firstmeasure/current`. Restart this service
  after a release that changes worker code, as with the job worker.
- Production topology is unchanged by this record.
