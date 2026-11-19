# Setup steps: questions asked once, required anywhere

A **setup step** is a question about the organization (or a person) that is
answered once, kept as data, and asked by whichever setup needs the answer first.
"What kind of company are you?" is the first: the Operations setup needs it
before its project question, and signup or a main onboarding flow can ask it
too. Whoever asks first wins; everyone after reads the answer and skips the step.

Setup steps are part of the [guided experiences](guided-experiences.md) runtime,
not a second engine: a step is drawn by the same setup player, in the same frame,
with the same progress and events.

## Files

| Where | What |
|---|---|
| `public/v1/guided-experiences/setup-steps.ts` | Reads the steps from the config library (kind `setup_step`), the step schema, `checkSetupStepGraph`, `stepSatisfied` (a published data read), `missingSetupSteps`, `injectedStep`. |
| `public/v1/config-library/kinds/setup_step.ts` | The library kind: the checks a step's save must pass (its export and action are published, its requirements exist and never go in a circle). Steps (`company.type`, `company.services`) are its entries; `registry.ts` derives their `setup_step.<id>` experiences. |
| `public/v1/guided-experiences/service.ts` | `resolve()` injects unanswered required steps; events accept them; the chooser reads the company profile. |
| `public/v1/guided-experiences/publication.ts` | The `setup-steps` provider: `catalog` and `status`. |
| `public/v1/company-profile/` | The first steps' data: `catalog.ts` (kinds of company and kinds of work), `profile.ts` (read, save), `publication.ts` (`company-profile` provider, `company-profile.save`). |
| `public/libraries/guided-experiences/guided-setup.js` | The player: the `module` widget, saving a step on Continue, `entryOf`, no step count. |
| `public/libraries/guided-experiences/guided-experiences.js` | `FirstMateGuides.require(stepId)`. |
| `public/libraries/setup-steps/company-profile.js` | The company steps' own code (a setup-step module), who sells and who does the work included. |
| `public/v1/appointments/setup.ts` | The appointment steps' data (FM-515): the kinds of appointment, the `appointment-setup` provider, `appointments.kinds.save` and `appointments.setup.apply`. |
| `public/libraries/setup-steps/appointment-kinds.js` | "What kinds of appointments will you schedule?" (a setup-step module). |

## Declaring a step

A step is a `setup_step` [config library](config-library.md) entry, written on dev
(id = the step id), checked when it is saved:

```ts
// PUT /v1/config-library/entries/setup_step/company.services  { "data": … }
({
  id: "company.services", version: 1,                 // dotted; the id is stable
  title, subtitle, description,                       // copy: gx_ language keys
  ui: { widget: "module", module: "/libraries/setup-steps/company-profile.js?v=…" },
  options: { part: "services" },                      // fixed data for the UI
  requires: ["company.type"],                         // asked first when unanswered
  eligibility: { permissions: ["manage_company_settings"] },
  satisfied: { provider: "company-profile", export: "profile", path: "/answered/services" },
  writes: { action: "company-profile.save" }          // run as the person on Continue
});
```

- **What it writes** is a published action ([publication architecture](publication-architecture.md)),
  run as the person with the step's answer as input.
- **Whether it is answered** is a published data read as the person: the value at
  `satisfied.path` in that export is truthy (a non-empty list or object counts). A
  read that fails counts as unanswered. This is never a configuration check: an
  answer saved by signup, another setup, an agent or Settings all count the same.
- **Who answers** is `eligibility` (capabilities and permissions, `a|b` either). Someone
  who may not answer is never asked; the setup plays without the step.
- Saving a step or an experience is refused when a requirement names no step, when
  requirements would go in a circle, or when an experience has an own step with a
  required step's id. `ensureGuidedDefinitions` checks the graph again once per
  library change and logs a problem (a step deleted since) instead of stopping.

## Requiring and injecting

An experience names `requires: [stepId]` (asked before its first step), or one of
its steps does (asked just before that step). When the experience is resolved for a
person (`availableExperiences`), each required step that is unanswered and that the
person may answer is put into the steps sent to the browser, its own unanswered
requirements first, each once. An injected step carries
`setup_step: { id, version, writes, injected_for }`. Satisfaction is read once per
step per list request, however many experiences require it.

So the same setup is shorter for a company that has already answered, and longer
for one that has not; nothing counts steps.

The Operations setup's `document` step requires `company.services`, which requires
`company.type`: an organization that has answered neither gets
path → company type → services → the project; one that has answered both goes
straight from the path to the project.

**Require from code.** Every step is also an experience, `setup_step.<id>`, with no
steps of its own and the step as its requirement (`completion.screen: none`).
`FirstMateGuides.require('company.services')` plays it: when everything is answered it
resolves `{ status: 'satisfied' }` and draws nothing; otherwise it asks only what is
missing, in the standard frame, and closes. A signup or main onboarding flow requires
a step by calling this or by naming it in its own definition's `requires`. Neither the
signup sandbox pages nor the MVP configuration call it yet.

**Where a step was answered.** The player records `step_view`, `step_done` and `step_skip` events with the step's id
under the experience that asked it, so the newest `step_done` naming a step is where it was answered (and by whom).
An answer saved outside a guided setup (Settings, signup, an agent) has no event. The dev console's Setup section
(FM-571, [dev console](dev-console.md)) shows this beside each step, and can test a step (asked again even when
answered, saved for real) and roll its tests back.

## The standard step frame

Every setup step, wherever it is injected, is drawn in the setup player's frame
(`guided-setup.js`): the setup's badge, the step's title with its subtitle in the
info tooltip, the step's UI, and Back and Continue. There is **no step count and no
progress bar**: a flow's length is not known ahead (required steps come and go with
the data, branches and answers change what is next), so the frame only goes to the
next step, and Back returns along the way taken. A setup-step's answer is kept apart
from the experience's selections and never reaches the experience's completion
action. Continue saves the answer with the step's action before moving on; a failed
save stays on the step with the reason. Going to a step (in order, by a fixed `next`
or a branch) lands on the first unanswered step injected for it (`entryOf`).

## Steps with their own code (the module contract)

A step whose UI is `module` names a browser ES module served from this site's
`/libraries/` (with an optional `?v=` cache key; checked in the schema and again in
the browser). The player imports it when the step first shows and calls
`mount(el, ctx)`. `ctx` is what every widget gets: `step`, `options`, `answer` (this
step's answer so far, kept across Back), `change(patch, summary)`, `advance()`, `L`,
`H`, `esc`, `actions` (the title row), plus `read(provider, export, { path, args })`, a
published data read as the person in their organization. The module returns
`{ valid(), hint(), summary(), answer(), escape(), destroy() }`. Continue waits for
`valid()`; `hint()` says why it is disabled; `answer()` is what the step's action
receives; `escape()` closes something of the module's own (a dropdown) and returns
true, otherwise Escape asks to close the setup. A module reads only through the
publication layer and writes nothing itself. A module never re-renders the element a
click landed on: the project window treats a click whose target has left the page as
a click outside.

Simple steps can still use a registered widget (`ui: { widget: "roof-types" }`) instead
of a module.

## The company steps

`company.type`, "What kind of company are you?": a search box over the kinds of
company (label and the words people use: typing "roofer" finds a roofing contractor;
Enter picks the best match) shown as tiles, each with its first kinds of work, and
Other with the person's own words. `company.services`, "What kind of work do you do?":
the kinds of work suggested for the company type (read back from the profile just
saved), multi-select, Select all, and a search across every kind of work in a custom
dropdown; anything that matches nothing is added in the person's words.

The catalog (`company-profile/catalog.ts`) is data that only grows: never change an
id or its meaning. It maps onto what exists rather than adding a parallel taxonomy:
a company type names the chooser's `organization.industry` (which the roofing price
book setup reads) and its CRM industry pack (`crm/presets.ts`); a kind of work names
its measurement schema (`work_kind`: roofing, gutters, siding) where there is one, and
the profile publishes the resulting `work_kinds`. The signup sandbox's prototype
service lists (`spg_home_improvement_services`, `spg_roofing_profile`) are covered by
catalog entries; those pages still store their own sandbox settings.

The answer is saved for the organization in the default branch's `company_profile`
module, only through `company-profile.save` (`manage_company_settings`; the generic
branch-module route needs the same permission). It is read through
`company-profile.profile` (`view_projects`) by setups, other apps, modules and agents
(how-to `set_company_profile`). `chooserContext` exposes `organization.industry`,
`organization.industry_sets`, `organization.company_type` and `organization.services`
to conditions.

### Industry sets

What differs for a family of trades is decided in one place, the catalog's
`INDUSTRY_SETS` (GP-16): a named set of `organization.industry` values, such as
`roofing_exteriors` (roofing, exteriors, and the older organization field's
`roofing_and_exteriors`). The chooser puts the sets an organization's industry belongs
to in `organization.industry_sets` (`industrySetsFor`), so a condition says
`{ field: "organization.industry_sets", operator: "contains", value: "roofing_exteriors" }`
instead of repeating industries; a company type joins a set by its industry. Sets only
grow, like the rest of the catalog. The `guided_experience` kind refuses a condition
that names a set, company type or service the catalog does not have
(`catalogConditionErrors`). The dev console's **What drives setup** diagram shows,
for any company type, which questions, sets, variants and pages follow
([dev console](dev-console.md)).

## Who sells, who does the work, and the kinds of appointments (FM-515)

Three more steps, asked first by the [appointment setup](guided-experiences.md#appointment-setup) and by anything
else that needs the answer (the [document setup](guided-experiences.md#document-setup) asks `company.sales_team` before a
proposal's questions):

- `company.sales_team`, "Who does the sales in your company?": just me, a small sales team, a sales team with
  managers, or no sales appointments. `company.workforce`, "Who does most of the work?": just me, our own crews,
  subcontractors, or crews and subcontractors. One choice each (parts `sales_team` and `workforce` of
  `company-profile.js`), both requiring `company.type`, saved in the company profile with `company-profile.save`
  (`sales_team`, `workforce`) and read from `company-profile.profile` (`answered.sales_team`, `answered.workforce`,
  and `sales_is_team` / `workforce_is_team`, whether the answer is a group of people). The answers are catalog data
  (`SALES_TEAMS`, `WORKFORCES` in `company-profile/catalog.ts`) that only grows.
- `appointments.kinds`, "What kinds of appointments will you schedule?" (`appointment-kinds.js`): the kinds in the
  `appointment-setup.catalog` (sales appointment, inspection, installation, repair, service call, maintenance,
  delivery, final walkthrough, team meeting; data that only grows), the ones suggested for this company already
  picked, each with pills that say sales, production or other, and the person's own kinds by name. It requires
  `company.services` and `company.sales_team` (the suggestions read them). `appointments.kinds.save` makes each kind
  an appointment type (a scheduling catalog preset, written with `saveAppointmentCatalog` in the person's branch): a
  catalog nobody saved (the built-in Sales and Production) becomes exactly the kinds picked; a saved one keeps
  every type it has and gains the kinds it lacks. Answered is `appointment-setup.status` `/answered/kinds`.

What was answered about appointments is kept in the default branch's `appointment_setup` module, apart from the
catalog: the catalog says what can be booked, this what the organization told us.

## How many locations (GP-15)

`company.locations`, "How many locations do you work out of?": one, two, three, or more with the number typed (up to
20), part `locations` of `company-profile.js`, requiring `company.type`. Saved in the company profile with
`company-profile.save` (`locations`) and read from `company-profile.profile` (`locations`, `answered.locations`). The
[equipment setup](guided-experiences.md#equipment-setup) requires it and makes a facility for each location.

## Tests

`tests/setup-steps.test.ts` (schema, graph, injection and removal as answers arrive,
eligibility, events, the provider, the action, the chooser) and
`tests/appointment-setup.test.ts` and `tests/appointment-setup-browser.test.mjs` (the FM-515 steps and the
appointment setup; their library entries are `tests/fixtures/appointment-setup-library.json`, as put on dev) and
`tests/setup-steps-browser.test.mjs` (the frame with no count, search and pick, save
on Continue, a failed save, the services dropdown and Escape, Back, require when
answered, phone width). Run them with the guided-experiences tests in AGENTS.md.
