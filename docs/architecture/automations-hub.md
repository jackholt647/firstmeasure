# Automations Hub: the flow of boards

The Automations Hub (`portal.automations_hub`, `public/libraries/apps/automations-hub/app.js`) is a flowchart of how
projects move through an organization's boards (GP-110; GP-72 put it in More apps). It is a first prototype. It stores
nothing of its own: everything it draws is configuration that already exists, and everything it changes is saved
through the routes Settings > Project Scopes uses.

| On the chart | What it is |
|---|---|
| The **New leads** row at the top | Intake routing (`scopes/router.ts`): one box per routing rule, in order (the first that matches wins), then "Any new lead" / "Every other new lead" (the default). "No board yet" is the `unscoped` entry: the project stays a [new lead](opportunities.md#new-leads). |
| A wire from a lead box | The rule's (or the default's) entry scope. |
| The **lanes** down the left | The organization's scope categories (`scopes/categories.ts`), enabled, except `intake`. Sales and Production by default; Sales is built in. |
| A **board** with its stages | A scope template that is on and not intake, with the groups under its top phase as stages. It sits in the lanes of its categories, so a board in Sales and Production spans both. A board in no lane is listed under "Boards not in a lane". |
| A wire from a board | A `scopes.activateTemplate.v1` binding in that board (the stage it is in is the label). `scopes.activateFromProposal.v1` is drawn as a logic block, "Starts the boards for the work sold", whose dashed wires to the production boards show on hover. A binding with conditions is drawn as a logic block too. |
| The **Flows** row, under New leads | Each [flow](flows.md) something starts (a call script or workflow), drawn between what starts it and where it leads. Not drawn when nothing starts it. |
| A box on a flow's left | What starts it: an organization automation rule that is on and whose `input.flow_id` names the flow (the leads setup's rule on `lead.received` is drawn as "New leads"; another event by the rule's title), or "New menu" when `entry.new_menu.enabled`. |
| A flow's outcomes and their wires | One row per outcome, read from its effects: `scopes.activateTemplate.v1` wires to the board (`input.template_id`), `sales.markLost.v1` wires to **Lost** (placed right after the flows that can end there), anything else stays where it is ("Stays a new lead", "with a follow-up" when the step that ends with it leaves a to-do, a text or an email). |

## What people can do

- **Split new leads**: click "Any new lead" for a menu: by where they come from (`lead_source.kind`), by when they come
  in (`lead_source.received_local.hour` / `.weekday`, stamped by `receiveLead` on the organization's clock), by where
  the job is (`address` contains), or by anything else. Each part is a routing rule whose formula is the
  [one condition contract](automation-authoring.md) (`work/conditions.ts`); the hub adds no matcher. Clicking a rule's
  box edits its conditions, destination, order and on/off.
- **Connect**: drag from the dot under a lead box or a board onto a board (or onto "No board yet"), or click the dot
  and then click the board. A lead box sets its rule's entry. Board to board adds an `onCompleted`
  `scopes.activateTemplate.v1` binding to the source board's last stage (a template save: new instances only, as
  always). Clicking a board wire shows what it does and can remove it.
- **Open a flow**: click its box (or an outcome) to see the whole flow. With the flow editor on the page,
  `FirstMateFlowEditor.open(flowId, { readOnly: true })`; without it, the hub's own modal lists every step from the
  start (what is said, asked and done) and where each answer goes, a step or an outcome and that outcome's
  destination, with a "Try it" tab that plays it through `FirstMateFlows.preview` (nothing saved).
- **Send an outcome somewhere**: drag its dot (or click it, then click) onto a board, onto Lost, or onto "No board
  yet" (stays where it is). Its `scopes.activateTemplate.v1` / `sales.markLost.v1` effects are replaced and its other
  effects kept; a board it started before keeps its `instance_key`. Saved as a new flow version with
  `PUT /v1/flows/organizations/:orgId/flows/:id` and `expected_version` (the version read; a conflict reloads). The
  flow is read at its newest version for editors; when that has unpublished changes the save is a draft, so a drag
  never publishes someone else's work.
- **Lanes**: drag a board by its title into another lane; onto the line between two lanes to put it in both (its lane
  categories are replaced, other categories stay). Add a lane (a new category), rename one by clicking its name, or
  remove one (the category is turned off; Sales cannot be).

Only people with `manage_company_settings` can see intake routing or change anything; others see the boards and
lanes.

## The setup, beside the chart

The setup is the guided experience `automations.setup` (config library, `guided_experience`), played by the guided
runtime **embedded** in the hub's right-hand panel (GP-78's `container`), not as a modal, so the chart stays visible.
It plays by itself while intake routing was never saved (revision 0), and from the Setup button. It requires the setup
step `company.type` (asked first, only while unanswered). Its one step is the module
`public/libraries/guided-experiences/automations-setup.js`.

**It asks how the company runs, never how to configure anything** (GP-119). Someone who has never used the system
cannot say where new leads should go or which lane a board belongs in; they can say whether they call a lead first.
The questions, saved on the company profile as `lead_flow` (`company-profile/catalog.ts`, read by anyone through
`company-profile.profile`):

| Question | Answers | What it makes |
|---|---|---|
| When a new lead comes in, do you already know what the job is? (`job_known`) | yes (almost always), mostly, no | no: new leads wait as [new leads](opportunities.md#new-leads) ("No board yet") until a call says what the job is; otherwise they go straight onto the pipeline |
| Do you call each new lead before anything else? (`first_call`, not asked when `job_known` is no) | yes, no | yes: the pipeline's first stage becomes "First call" (to-do "Call the customer", the sales pipeline's call list); its own steps move to the next stage |
| Do you meet the customer before you give a price? (`visit`) | yes, no | yes: an "Appointment" stage after the first (to-do "Meet the customer"; without a first call, the first stage's to-do is "Book the appointment") |
| Once a job is sold, who runs it? (`handoff`) | same, separate | same: the pipeline spans Sales and Production. separate: it is in Sales, ends at the signature (the step that marks the sale won) and its last stage starts the production board `roof_replacement`, which is turned on and put in Production |

**Everyone starts on one pipeline**: the MVP platform's (`generic_roofing`, as the sandbox configuration
`swf_mvp_platform` installs it), from new lead to finished job, in the Sales and Production lanes, new leads straight
onto it. Unanswered questions mean exactly that. The server builds the pipeline from that source every time
(`pipelineDefinition` in `scopes/flow-setup.ts`), installing it when the organization lacks it; a wire someone drew
from one of its stages is kept, a renamed pipeline keeps its name, and the steps the setup adds (`setup_` ids) are
rebuilt, never repeated. A production board the setup turned on is turned off again when the job is no longer handed
off. The added steps tick themselves when a later step happens (an appointment booked, measurements ordered, a
proposal made or signed), like the pipeline's own.

After each answer the chart draws what the answers would make: the published read `automations-setup.plan` (args:
the answers; nothing saved) returns the pipeline and production board as they would be and routing's default, and
the hub's `preview({ routing, templates })` draws them over the saved state. "Set up my flow" saves with the
published action `automations.setup.apply` (same answers; `manage_company_settings`), run as the person: the answers,
the boards, which are on, their lanes and intake routing's default (rules are kept). The last page says what was set
up, in words. Each page points at the part of the chart it talks about (`spotlight`, a pulsing ring). The hub's
handle for this is `window.FirstMateAutomationsHub.active`.

**No small print on the chart.** What explains a name (New leads, the Sales lane, "Any new lead", "No board yet", a
rule's conditions) is a tooltip: an (i) beside the name, or the box's own; nothing is printed under it all the time.

## A board per kind of work (GP-141)

The answer to "What kind of work do you do?" (`company.services`, multi-select, [setup steps](setup-steps.md)) is the
organization's production boards: when `company-profile.save` saves the kinds of work, `syncWorkBoards`
(`scopes/work-boards.ts`) gives each one picked its board in the person's branch, on and in the Production lane, so
Settings › Project Scopes, Projects and this chart show it. Re-roofs, gutters, siding and kitchens use the
organization's own copy of the library board (`roof_replacement`, `gutters`, `siding_replacement`,
`kitchen_remodel`); any other kind of work gets a board of its own, `work_<service>`, named after it and copied once
from the library board closest to it (`repairs` for repairs, `maintenance` for inspections, cleaning and upkeep,
`roof_replacement` for storm and commercial roofing, `manual` for anything else), with `metadata.work_board` saying
which. Nothing is deleted or rewritten: a board already there is only turned on, and a board this turned on is turned
off again when its work is no longer picked (the branch's `work_boards` module records which). The hand-off setup above
never turns off a production board that is the board of work the company does.

## Not yet

- Conditions on a board-to-board wire are shown, not edited here (Settings > Project Scopes edits them).
- Where boards sit left to right is computed (entry boards first, a board next to the one that starts it); it is not
  saved.
- The CRM source catalog (`lead_source.source_id`) can be named as a field, but the split menu offers the lead kinds.
- What starts a flow is shown, not edited here (the leads setup and the rules editor make the rules). Flows started by
  a board's binding are not drawn yet. An outcome's wire to a lower lane can pass behind a board.
- The flow modal's copy is not yet in the language catalog (`catalog-source.json`); the inline English shows.

## Tests

`tests/automations-hub-model.test.mjs` (what the chart draws and what a drag writes, flows included: their starts,
outcome destinations, an outcome sent to a board or lost, and the whole-flow outline), `tests/automations-setup.test.ts`
(what the answers make and the setup action), `tests/work-boards.test.ts` (a board per kind of work, and the
appointment kinds offered for it) and `tests/lead-receive.test.ts` (the arrival time stamp).
