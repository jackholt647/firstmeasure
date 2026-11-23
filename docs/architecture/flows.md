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

Both libraries call `/v1/flows` beside the platform API's base (`PlatformAPI.baseUrl()` with
`/platform` replaced by `/flows`), as an absolute URL, because `PlatformAPI.request` prefixes
relative paths with `/v1/platform`.

## The editor

`public/libraries/flows/flow-editor.js` is the one editor, for call scripts and workflows alike:

```js
FirstMateFlowEditor.mount(el, { flowId | definition, readOnly, onSave, onChange, onClose })  // → { save, destroy, definition, dirty() }
FirstMateFlowEditor.open(flowId | null, { readOnly, definition, onSave, onClose })            // its own window; asks before closing unsaved
FirstMateFlowEditor.blankFlow('call' | 'workflow')
```

- **A map, not a list.** Steps are cards in columns by their shortest distance from the start
  ("Start", "Then 1", ...); steps nothing reaches are in a "Not reached yet" column; outcomes
  are the last column. Every way out of a step (a choice's options, an `outcome` block, branches,
  "then") is a row on its card with a line to the step or outcome it leads to. When the editor is
  narrower than 760px (a container query on its own width) the columns stack and the lines are
  left out; each row still names where it goes, and a step name jumps there.
- **Edits in place.** Clicking a card opens it where it is: its title, every block (`say`/`note`
  text with template chips for `{{answers.<key>}}`, `{{contact.first_name}}`...; `ask` question,
  input kind, options, required, `saves_to` including custom fields; `choice` options with where
  each goes, including "+ A new step" / "+ A new outcome"; `contact` and `project` modes and what
  they take; `action` with an automation picker and that automation's input fields, the copy of a
  text or an email kept as the block's `preview` until it is written separately; `outcome`;
  end `buttons`), add/remove/reorder blocks and steps, "after this step" or branches. Outcome cards
  edit the label, color and effects. The header has the name, the call script / workflow switch,
  Settings (description, icon, color, the New menu entry: enabled, label, icon, order; where it
  starts), Play and Save.
- **Play** opens `FirstMateFlows.preview` on the unsaved definition: nothing is saved.
- **Save** is `PUT .../flows/:id` with `expected_version` (or `POST .../flows` for a new flow) and
  publishes. A conflict (someone saved meanwhile) offers Reload. Validation issues carry a `path`
  (`steps.2.blocks.1.options.0.to`, below); each is drawn next to the field it names, the step or
  outcome it is in opens, and anything that names nothing drawn goes in the banner.
- **Read-only** (`readOnly: true`, how the automations hub opens a flow) is the same map with every
  field read-only and no add, remove or save; it reads the published version.

The list route (`GET .../flows`) also returns, for editors, `templates` (library `flow_template`
entries) and `actions`: the automation catalog's non-internal actions with their input schemas
(`flowActions()`), which the editor's action picker offers.

Every cross-reference issue from the contract names where it is: `start`, `steps.<i>.id`,
`steps.<i>.next`, `steps.<i>.next.branches.<b>.to`, `steps.<i>.next.otherwise`,
`steps.<i>.blocks.<j>.id|key|outcome`, `steps.<i>.blocks.<j>.options.<k>.to|outcome`,
`outcomes.<o>.id` (an outcome id used twice), `audience`.

Where it is embedded:

- **CRM settings › Flows** (`apps/crm/app.js`; CRM settings has subtabs General and Flows, route
  key `crmSettings`): the organization's flows with their kind, New menu entry and version; New
  flow (blank call script, blank workflow, or a library template, copied with
  `metadata.created_from`), Edit (read-only for people who cannot edit flows), Archive / Restore,
  Show archived.
- **Communications › Call scripts** (`apps/comms/workspace.js`): the flows of kind `call`, opened in
  the same editor; New script starts a blank call flow. The old `customer_call_scripts` are not
  shown or migrated here (the call surface's migration does that).
- The setup's script step and the hub's flow box (their own sessions) mount it the same way.

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
   surface (call scripts become flows; `customer_call_scripts` is migrated and dropped).
3. Website forms rebuilt as public flows (blocks for appointments, measurement and
   pricing in the evaluate-only sandbox, `page` surface); staff forms become flows.
4. Comparing a call's transcript with its script.

## Tests

`tests/flows.test.ts` (contract and its issue paths, runs, branches, saves_to, actions, outcomes,
access, the editor's action list), `tests/flow-editor-browser.test.mjs` (CRM settings › Flows, the
map and its lines, in-place edits, preview, save with `expected_version`, server issues beside
their field, a conflict, a new flow in the New menu, archive, read-only and narrow).
