# Platform Workflow Test Harness

These tests are meant to protect the low-level Platform systems that many UI features depend on: authentication, org-scoped project writes, scheduling, stages, triggers, and notifications.

Run from `public/v1`:

```powershell
npm.cmd run test:platform
npm.cmd run test:smoke
```

Use `npm.cmd` on Windows PowerShell because direct `npm` can be blocked by execution policy.

## What The Automated Tests Cover

`tests/platform-workflows.test.ts` starts a Fastify app with isolated temporary storage. It never writes to the real `v1/storage` folder.

Current coverage:

- Registering a new org owner seeds standard scheduling roles.
- Scheduling a `sales_appointment` through `POST /projects/:projectId/events` saves the event and emits API triggers.
- The default trigger advances project stage from `contacting` to `appointment_scheduled`.
- Custom branch stages can use deterministic generated trigger event names like `project.stage.entered.job_sold`.
- Trigger action `notification.create` creates passive notifications.
- Notification role targeting works.
- Per-user notification state tracks `seen_at` and `dismissed_at` without mutating the notification itself.
- Push notifications are logged to `push_log` but not delivered.
- Email lead import creates branch inbound lead settings and turns a Postmark payload into a `new_lead` project, customer, and notification.
- Website embed lead forms can be stored on branch lead settings, read through public form config, and submitted into the generic Platform lead creator as `website_embed`.
- Canvassing tests cover the separate Canvassing API and generic lead promotion path.
- App rollout flags gate lead import, website embed, and canvassing routes; tests seed org `global.app_flags` directly and confirm hidden APIs reject direct calls.

`test:smoke` also runs syntax checks over the browser libraries/scripts, PHP lint over `public/platform`, and `tsc --noEmit`.

## Manual/LLM Checklist

Use this after larger UI changes or any change involving modal layout, search, notifications, scheduling, or calendar rendering:

1. Log into Platform and confirm the right-content top bar appears above tab content.
2. Confirm existing tabs still scroll correctly and are not hidden under the top bar.
3. Open a project, schedule a sales appointment, close/reopen the project, and confirm the event persists.
4. Confirm scheduling a sales appointment from `contacting` changes the project stage to `appointment_scheduled`.
5. Confirm Calendar day/week/month views show the scheduled event and clicking it opens the project.
6. Create or trigger a notification and confirm the bell count updates.
7. Open the bell dropdown, mark a dismissible notification done, refresh, and confirm it stays hidden.
8. Confirm non-dismissible notifications do not show a Done button.
9. Confirm project/customer search shows useful results and opening a project result launches the project modal.
10. Open Settings -> Lead Import and confirm the inbound email loads, copies, and regenerates.
11. Create a website embed form, edit copy/colors, copy the embed code, and confirm the live preview updates.
12. Toggle canvassing off and confirm the Canvassing sidebar tab disappears; toggle it back on and confirm it returns.

If any manual behavior fails, add a focused automated test when possible. If browser-only rendering is the only issue, record the repro steps in this README before patching.

## Design Rules For Future Tests

- Use isolated temp storage for API tests.
- Prefer API route tests over direct storage helper tests for trigger-worthy behavior.
- Do not test FirstMeasure internals from this suite unless the Platform workflow requires them.
- Any action that should emit triggers must be tested through its API route, not by writing JSON directly.
- When adding a new trigger action, add one test showing it can be configured from branch trigger data and run from `triggers/emit` or the real API event route.
