# Flows: one library for scripts, workflows and forms

Status: designed 2026-11-23 (Jack's direction in the new-leads conversation); phase 1 being built.

A **flow** is a sequence of steps a person goes through to say things, get information
and do things, in order, with branches. A call script is a flow. A "fill this in" workflow
is a flow. A website form is a flow a visitor plays. They are one kind of data, played by
one runtime and drawn by one player, so they stay at parity: anything one can do, the
others can. What differs is the **surface** that wraps the player (a call, a modal, a
panel, a public page), never the flow's shape.

Flows replace the platform call scripts (`customer_call_scripts`), the call wrap-up's
fixed dispositions as the way a call ends, the unused `inline_disposition` metadata, and
(phase 3) website forms, which are rebuilt as public flows. Backwards compatibility is not
a constraint where it would cost the architecture: no customers use these surfaces yet,
and FirstMeasure's own production data is never touched.

Not flows: guided experiences (platform setup, authored by us, not by organizations; they
embed the flow player where a setup shows or edits a flow) and FirstMeasure's internal
call scripts (`/v1/internal` `call_scripts`, a separate product whose UI is retired).

## The words

| Word | Means |
|---|---|
| **flow** | The definition: steps, blocks, outcomes. Organization data, versioned. |
| **step** | One screen of the flow. Has blocks and says where to go next. |
| **block** | One thing on a step: a line to say, a question, a choice, a record to find or create, an action, a button. Capability is added as a **block kind**, never as a mode or a per-flow switch. |
| **run** | One time someone plays a flow: its answers, the path taken, the records it found or made, its outcome. Kept on the server. |
| **outcome** | How a run ended (talked and booked, no answer, not a lead...), with the effects that follow (route to a board, mark lost, retry later). The hub draws outcomes as wires. |
| **surface** | What wraps the player: `modal`, `call`, `panel`, `page` (public), `preview`, `editor`. |
| **kind** | `call` (a call script: the call surface adds recording, the dialer and the call's wrap-up) or `workflow` (no call). One switch on the flow; it changes the wrapper and how `say` lines are drawn, nothing else. |
| **audience** | `staff` (signed in, plays as the person) or `public` (anyone with the link, phase 3). |

## The definition

```ts
// flows/contracts.ts
Flow = {
  id, name, description, icon, color,
  kind: "call" | "workflow",
  audience: "staff" | "public",
  start: StepId,
  steps: Step[],
  outcomes: Outcome[],
  entry: {                                   // where people can start it (all optional)
    new_menu?: { enabled, label, icon, role_ids, sort_order },   // the portal's New menu
    project?: { enabled, label },                                // a project's action menu
    contact?: { enabled, label }
  },
  metadata: { template_id?, created_from? }
}
Step = { id, title, blocks: Block[], next: StepId | { branches: [{ when: Conditions, to: StepId }], otherwise: StepId | null } | null }
Outcome = { id, label, color, effects: Effect[] }        // Effect = { automation, input, when? }
```

- `next: null` ends the run on that step. A step whose `choice` block jumps (an option
  with `to`) goes there instead; otherwise `next` is followed. Branch `when` is the
  [one condition contract](automation-authoring.md) (`work/conditions.ts`) over the run's
  context; flows add no matcher.
- Step and block ids are stable within a flow; answers are keyed by block `key`, never by
  position.

### Block kinds (`flows/blocks.ts`, data that only grows)

| Kind | What it is |
|---|---|
| `say` | Words to read out (`call`: drawn as script lines) or show (`workflow`: an instruction). Templated. |
| `note` | Guidance for the person playing it, never said to the customer. |
| `ask` | A question with an answer: `input` text, paragraph, number, money, select, multi, yes_no, date, phone, email, address. `key`, `label`, `options`, `required`, `saves_to` (below). Input kinds match the form item kinds so forms rebuild onto them. |
| `choice` | A question whose options say where the flow goes (`options[].to` a step id, or `outcome` an outcome id): "Did they answer?" |
| `contact` | Find or create the contact: `mode` find, create, find_or_create; the fields it takes come from earlier answers (`from: { name: "answers.name", phone: ... }`). The run's `contact` is what it found or made. Uses the contacts writers and matching (`contacts.md`). |
| `project` | Find, or create a lead (`receiveLead`, source `manual_lead`, so intake routing and `lead.received` run), or create a project (`createProject`). The run's `project` is the result. |
| `action` | Runs an automation from the catalog (`communications.sendSms.v1`, `work.createTodo.v1`, `scopes.activateTemplate.v1`...) when the step is left. `preview` shows the person what it will do, with the copy (a text's words). The step emits `flow.step.completed`; the work engine reads the step's actions from the stored flow version and runs them like organization rules (same records, idempotency per run, step and block, `when` conditions). |
| `outcome` | Ends the run with an outcome (its effects run). |
| `buttons` | What the person can do at the end: `open_project`, `open_contact`, `go_to` (a portal tab or URL), `restart`, `start_flow` (another flow), `close`. `auto` picks one without asking. |

`saves_to` names where an answer is written when the step is left, through the existing
writers: `contact.<field>`, `contact.cf.<path>`, `project.<field>`, `project.cf.<path>`
(custom fields through `custom-fields.<entity>.write`). An answer with no `saves_to` stays
on the run (and is readable from it).

Templating (`{{...}}`) and conditions read one context: `answers`, `contact`, `project`,
`run` (`started_by`, `kind`, `call`), `organization`, `user`.

## Runs

A run is server-authoritative, like a guided experience: the browser sends a step's
answers, the server validates them against the version the run started on, runs the
step's actions and saves, resolves where to go, and returns the next step. A run pins the
flow **version** it started on; editing a flow affects new runs only.

`flow_runs` (SQL): `id, organization_id, flow_id, flow_version, status (open|done|abandoned),
step_id, path_json, answers_json, contact_id, project_id, call_id, outcome_id,
started_by, started_at, finished_at, source_json` (what started it: `new_menu`,
`automation` with the rule, `call_list_entry`, `call`, `crm`, `setup_preview`).

Routes (`/v1/flows/organizations/:orgId/...`, access tables per request security):
list/read/save/publish flows, `POST runs` (start), `POST runs/:id/steps/:stepId` (answer
and advance), `POST runs/:id/back`, `POST runs/:id/abandon`, `GET runs/:id`.
Published reads (`flows` provider: `catalog`, `flow`, `run`) and actions (`flows.save`,
`flows.start`, `flows.advance`) let agents, modules and setups do the same. The
automation `flows.start.v1` starts a run from a rule or binding (a new lead arrives →
the new-lead flow is waiting for someone on the lead's call list entry).

## Where flows come from

Library defaults are config library entries of the kind `flow_template` (like
`form_template`), written on dev. An organization's flow is its own copy (`created_from`).
The first is `new_lead_call`, built by the leads setup from its answers (below).

## The player and the surfaces

`public/libraries/flows/flow-player.js`: `FirstMateFlows.mount(el, { orgId, flowId | runId |
definition, surface, context })` draws one step at a time from the run, the same way
everywhere. `surface` only adds the wrapper:

- `modal`: its own window (New menu, a project's or contact's menu, a CRM row);
- `call`: inside the call surface (calling-runtime): `say` lines are big and readable, the
  call's controls and recording wrap it, and the run's outcome is the call's wrap-up;
- `panel`: embedded in another app (the CRM worklist, the hub's side panel);
- `preview`: plays a definition without saving anything (setups, the editor);
- `page`: the public renderer (phase 3, replacing `forms-embed`).

The editor (`public/libraries/flows/flow-editor.js`) is one component, embedded in CRM
settings › Flows, call center settings › Scripts, the setup's script step and the hub's
flow modal. It shows the whole flow as its steps and branches, and edits in place.

## The call surface

Built 2026-11-23. A call's script is a run of a `call` flow, linked both ways:
the call keeps `metadata.flow_run_id` and `metadata.flow` (`{id, version, name}`),
the run keeps `call_id`. `comms/calls/flow-runs.ts` owns the link.

- **Starting.** `POST /v1/comms/.../calls` with `flow_id` (refused before dialing
  when it is not published) or `flow_run_id` (carry on the lead's open run), or
  during the call `POST calls/:id/flow` `{ flow_id | run_id }`. A run started
  through `POST /v1/flows/.../runs` with `source.call_id` is checked the same way
  (only someone who may change the call, and not after its outcome is saved) and
  linked. A carried-on run must be for the call's project or contact; a run
  waiting on a lead (`source.kind` `automation` or `call_list_entry`) is anyone's
  to carry on, a person's own run only theirs.
- **Playing.** The call's owner plays it (`FirstMateFlows.mount(el, { runId,
  surface: 'call' })`), including after a transfer or takeover: `load` lets
  whoever has the call now play its run. Observers read `flow_run` from
  `GET calls/:id` (`runSummary`: step, labelled answers, outcome).
- **Ending.** The run's outcome is the call's result: `result.flow_outcome`
  `{run_id, flow_id, outcome_id, label, color, disposition, next_action}`. The
  wrap-up is pre-filled from it and the saved wrap-up keeps it;
  `require_disposition` is unchanged. The outcome's effects run in the work engine
  like any flow's. An outcome says which wrap-up it means with
  `call: { disposition, next_action }`; without it, common ids read as usual
  (`ready`/`booked` answered, `call_back` callback, `no_answer`, `voicemail`,
  `busy`, `not_a_lead`/`wrong_number` wrong number, `do_not_call`) and anything
  else pre-fills nothing (`callResultForOutcome`, `flows/contracts.ts`).
- **Without a call.** The CRM worklist plays the lead's open run (from a rule, a
  call list entry, the CRM or a call) or the published flow its call list entry
  names (`metadata.flow_id`, on the row as `flow_id`) in the panel instead of the
  fixed result form, which stays for leads with neither ("Record a result
  instead" switches). A run played for a call list entry with no call completes
  the entry with its outcome.
- **Migration.** `comms/calls/script-migration.ts` copied `customer_call_scripts`
  into flows `call_script_<id>` once at startup (each section a step of `say`
  lines, the questions a last step of `ask` blocks `q_<n>`; the newest published
  version stays what plays, a newer draft follows as a draft; archived scripts are
  dropped) and dropped the table. `script_answers`, the `call-scripts` routes and
  the Comms Scripts editor are gone; Comms › Scripts lists call flows and opens
  them in the flow editor (`FirstMateFlowEditor.open`) or a preview.

## The New menu

Any flow with `entry.new_menu.enabled` is a New menu item, `flow:<id>`, beside the
built-in items, in the order `platform.new_button_items` gives. Choosing it opens the flow
in a modal. A T-shirt order is a flow like any other: no code.

## The automations hub

A flow started by a rule or a board is drawn as a box between what starts it and where
its outcomes lead: "New lead → New lead call → (Booked → Sales board, Not a lead → Lost,
No answer → retry)". An outcome's wire is read from its effects
(`scopes.activateTemplate.v1`, `sales.markLost.v1`, the retry follow-up). Clicking the box
opens the flow in the editor.

## The leads setup (setup steps, asked once)

Asked on the first visit to the CRM or the Automations Hub (`requires`, setup steps):

1. `leads.sources`: where leads come in (website, the lead inbox, lead services, calls) and
   turns those on.
2. `leads.contact`: "When a new lead comes in, how do you usually contact them?" Call
   (default), text, email.
3. `leads.no_answer` (call only): "If they don't answer, what do we do?" Text them, email
   them, try again later (any of them).
4. `leads.questions`: "If they do answer, what do you want to find out?" (suggested
   questions for the company type, each saved to a field, plus their own).
5. `leads.script`: "Here's your new lead call script": the flow those answers make, in the
   editor, played in preview, editable there. Says where to edit it later (CRM settings ›
   Flows, call center settings).
6. `leads.new_menu`: how a lead is added by hand: the New menu with its items and order,
   drawn as it will look; New › Lead starts the new-lead flow in a modal.

Saving the setup: new leads from outside sources arrive as new leads (intake routing's
default `unscoped`), the new-lead flow is started for each one, and New › Project still
goes straight to the default board.

## Phases

1. Contract, store, runs, published reads and actions, the player (modal, preview, panel),
   the default `new_lead_call` flow, New menu `flow:<id>` items.
2. The leads setup steps; CRM settings › Flows; the editor; the hub's flow box; the call
   surface (call scripts become flows; `customer_call_scripts` is migrated and dropped; built, see "The call surface").
3. Website forms rebuilt as public flows (blocks for appointments, measurement and
   pricing in the evaluate-only sandbox, `page` surface); staff forms become flows.
4. Comparing a call's transcript with its script.

## Tests

`tests/flows.test.ts` (contract, runs, branches, saves_to, actions, outcomes, access),
`tests/flow-player-browser.test.mjs` (the player in each surface), `tests/customer-calls.test.ts`
(flows on calls, outcome to wrap-up, the script migration), `tests/call-flow-script-browser.test.mjs` (the call panel).
