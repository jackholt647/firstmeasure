# Assistant agents, main thread and dashboard — development, September 26, 2026

Source commits `802b26f`, `d0c5ce6` and `602d359` are pushed on
`codex/assistant-agents-dashboard-20260926` (based on terminology `a49ff93`).
The release is active on dev.1m8.ai. Production is unchanged.

## Behavior

- The assistant can create personal **agents**: named recurring or one-time tasks
  (`create_agent`, `list_agents`, `update_agent`, `delete_agent`, `run_agent_now`).
  Runs execute as their creator, post to the creator's single **main thread**,
  pin artifacts to the dashboard and send a push notification that opens the
  assistant. Delivery is in-app and push; agents do not send SMS.
- `create_artifact` produces declarative bar, line, pie, donut, metric, table and
  text artifacts rendered by the browser's own SVG/HTML code.
- Navigation: main thread, collapsible Agents and Side chats, new side chat and
  settings in the header, search at the bottom. Opening an agent shows its setup,
  run/pause/delete actions, recent runs and a chat for changing it.
  Settings → Agents lists every agent. In the full workspace the dashboard sits
  left of the conversation with a hover-revealed draggable divider and a centered
  composer; narrow, docked and hidden-dashboard layouts show artifacts inline.

See [global assistant architecture](../../docs/architecture/global-assistant.md).

## Active releases

| Role | Previous | Release |
|---|---|---|
| web `fm-dev-web-598520065` | `7cd30733636f08b33188a300da29e79265893308` | `5e4a6a035fc46b8579a44978ea2384597a807377` |
| pool `fm-dev-web-603124965` | `d273a4d8e413a50cea272b24429421f8fc1ae9c4` | `dd9d04913d7d77b217d09c779e0a93aa0084b2f1` |
| legacy (compatibility) | `ab389b7f53cff5329c157a4a15de9d947fd04ef7` | `d99616fe6ac954accf5baa9ee3ccf80889424f01` |
| worker | `adb3aa510384b02362448a8d5c3707d71431231a` | `7c7f9458cd7e68e86d55d713c8105d5a2682d4b3` |

Each release is the role's live commit plus a cherry-pick of the feature commits
(`codex/assistant-agents-<role>-<sha>`). Web and pool had byte-identical copies of
every touched file; worker and legacy received backend source and compiled files
only, with `assistant/api.ts` merged without their absent attachment feature.
An intermediate release (`7d8e908`, `ba1467d`, `946acb5`, `b05d094`) ran the agent
lane in the platform heartbeat. It was replaced within minutes, before any agent
existed, because the development heartbeat owner has no OpenAI key. The lane now
starts only in processes serving the assistant API with the key (both web nodes).

## Scheduling on development

No development node runs `platform_worker.js`, so the existing Channels
`schedule_wakeup` sweep does not run on development. Assistant agents use their
own `assistant_agent` wakeup kind and lane, which does not execute dormant
Channels jobs. No platform worker or topology change was made.

## Verification

- Local: TypeScript check, 27 assistant/channels-agent/agent-store tests
  (including scheduled delivery through the real queue with Channels disabled,
  pause/resume without replay, ownership, the lane ignoring Channels schedules and
  artifact validation), the same assistant suite on embedded PostgreSQL (16/16),
  publication suite (47 passed, 1 skipped) and frontend checks (6/6).
- UI checked in a local harness with the real window manager at 1440×900 and
  375×812: full, docked, left-column and phone layouts, agent view, settings,
  artifact close/hide/reopen and resize fitting.
- All roles compiled per role; staging verified predecessor identity, per-file
  baseline hashes, payload SHA-256 `44acf9a946f4fe9e5fc88efa4f5f3875cd33275ef4e2580c2157164555a56054`,
  `node --check`, and a module smoke test on Linux. Roles were activated
  sequentially with guarded rollback; the worker waited for no running jobs.
- Final readiness: both web nodes report their releases with development data and
  enforced outbound safety. Public `platform-assistant.js` SHA-256
  `15b68d1fcd0abbb1e884c07f62bcd6aa29c1c697cc5823873153f6b8b2fa39a2` matches.
  The additive agents store migration (schema 6: agent metadata columns and
  `assistant_dashboard_items`) is applied in the development database.
- Not verified live: an authenticated conversation, a real scheduled run and a
  device push. No session was created for a user account.

## Rollback

Use the guarded activation workflow to return each role to the previous release
above, checking for later deployments first. The schema change is additive; older
code ignores the new columns and table. Delete test agents in Settings → Agents
before rolling back: older sweep code does not recognize the assistant surface.

## Follow-up: navigation height and visuals toggle

Commit `afea14a` fixes the main-thread row, which used the class `main` and was
stretched by the portal's own `.main` layout rule (row modifiers now use `is-*`),
removes the empty-section hint text, and makes the header chart button a
show/hide visuals toggle in every window mode (dashboard column in the full view,
chart cards versus chips elsewhere) instead of maximizing. UI-only releases:
web `5e4a6a0` → `44a12c0381a5c0b8ce7665e11f124bad6fa38da5`, pool `dd9d049` →
`a3e9f5adf5a45fae77e81ee4461ca4f321fd51c4`; worker and compatibility unchanged.
Guarded staging/activation passed; the public asset SHA-256 is
`aad36f0204eaec4918ba2fa232a3cf2b001ce0766e33b6584e0d233df061fbeb`.

## Robustness QA and hardening

Fault injection (`tests/assistant-robustness.test.ts`, 11 tests) and two live rounds
against the real model (51 checks across the main thread, side chats, agent
configuration chats, scheduled runs, Channels DM/mention and the notification
assistant) found and fixed:

- Raw provider errors, which can include key fragments, were shown to users. Users
  now see plain messages; details stay in the run trace with keys redacted.
- An impossible cron such as February 31 blocked the Node event loop for 56 s
  (also affecting Channels `schedule_wakeup` and automation schedules). Cron search
  now walks civil days with strict validation and cached formatters: under 1 ms,
  identical results across zones and DST.
- Blank, non-text and oversized messages reached the model; they are now rejected.
- Turns could run about 32 minutes while the browser gave up at 160 s. Turns stop
  after 5 minutes, and the browser waits for the reply after a timeout, dropped
  connection or busy thread.
- Clarifying questions and rule-based refusals were recorded as failures.
  `report_result` has a `needs_input` status.
- Relative times failed and the model asked for a timezone. The prompt and workspace
  context now carry the company's local time and timezone.

Behaviour confirmed live: sub-15-minute, invalid-date, past and invalid-hour requests
are declined with a question; no system-prompt disclosure; no fabricated data;
messaging-off respected; loop bait ends; concurrency is refused cleanly; relative
reminders fire in the assistant and in Channels; no stuck threads or jobs.

Releases: web `a042c677003ae9da1e142967d4f3e5d3081257ca`, pool
`291c31d805b356b213892568bf080ac80d3e40da`, legacy
`a1b2f83b6dbfc1bccdd86b4eda172c06eab977a9`, worker
`7c50c5583ee0ee3d3b20433da93b27f35b79ca6f` (intermediate hardening releases
`7427c8f`, `092b6ff`, `79d2eb2`, `67df4c4`).

The live QA ran in an isolated in-process app on the first web node with temporary
storage and throwaway companies; no development database rows or user accounts
were created. The app's Channels, messaging and internal stores default to paths
relative to the working directory, so the harness created `public/v1/storage`
inside releases `7427c8f` and `a042c67` on that node (only QA data; the service
never opened it; the pre-QA release had no such directory). It was removed and
both web nodes re-verified. Future in-process harnesses must run from a copy or set
those store roots.
