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
`public/libraries/guided-experiences/automations-setup.js`:

1. **Where do new leads go?** The boards, the one whose name matches what the company does first
   (`suggestBoards`; a roofer gets the roofing board).
2. **Is that board the whole job?** One board from lead to finished job (it spans Sales and Production; the default
   for roofing and exteriors) or the sales part. Continue saves both with the published action
   `automations.setup.apply` (`scopes/flow-setup.ts`): intake routing's default entry and the board's lane
   categories; rules are kept.
3. **Different leads, different boards** and 4. **Connect your boards**: how to split leads and connect boards,
   pointing at the chart.

While it plays, each answer is drawn before it is saved (the hub's `preview`) and each page points at what it talks
about (`spotlight`, a pulsing ring). The hub's handle for this is `window.FirstMateAutomationsHub.active`.

## Not yet

- Conditions on a board-to-board wire are shown, not edited here (Settings > Project Scopes edits them).
- Where boards sit left to right is computed (entry boards first, a board next to the one that starts it); it is not
  saved.
- The CRM source catalog (`lead_source.source_id`) can be named as a field, but the split menu offers the lead kinds.

## Tests

`tests/automations-hub-model.test.mjs` (what the chart draws and what a drag writes), `tests/automations-setup.test.ts`
(the setup action) and `tests/lead-receive.test.ts` (the arrival time stamp).
