# Guided experiences: setups, tutorials and assistant help

One data-driven system plays every in-app guide: overlay tutorials, modal setups,
agentic setups (the agent beside a widget) and the assistant's suggested
questions. An experience is a definition (data); one runtime plays it, keeps
progress on the server, decides which variant someone gets, and records
exposure and outcome events for later analysis. Nothing checks which
configuration an organization was signed up with: who sees an experience is its
eligibility and its chooser.

## Files

| Where | What |
|---|---|
| `public/v1/guided-experiences/contracts.ts` | The definition schema (zod): kinds, steps, triggers, variants, completion, FAQs, selection limits. |
| `public/v1/guided-experiences/registry.ts` | `registerExperience`, `registerTabFaqs`, `addTabFaqs`, `registerGuidedSource`. A malformed definition stops the server. |
| `public/v1/guided-experiences/chooser.ts` | Deterministic bucketing and variant choice; region and size helpers. |
| `public/v1/guided-experiences/store.ts` | SQL store `guided-experiences`: `guided_progress`, `guided_events`. |
| `public/v1/guided-experiences/service.ts` | Eligibility, resolving for a person, events, completion, the scripted conversation, the assistant hook. |
| `public/v1/guided-experiences/api.ts` | Routes under `/v1/guided-experiences`. |
| `public/v1/guided-experiences/definitions/*.ts` | Domain definitions. `materials.ts` holds the first ones. |
| `public/libraries/guided-experiences/guided-experiences.js` | `window.FirstMateGuides`: API client, triggers, the overlay engine, assistant FAQs. |
| `public/libraries/guided-experiences/guided-setup.js` | `window.FirstMateGuidedSetup`: the `modal` and `agentic` players and step widgets. |
| `public/v1/pricebook/setups/` | Price book setups by trade and the `pricebook.setup.apply` action, plus `pricebook.prices.list` / `pricebook.prices.update` for price sheets. Roofing is the first. |
| `public/libraries/guided-experiences/supplier-columns.js` | `window.FirstMateSupplierColumns`: supplier columns and the supplier price sheet hand-off, mountable anywhere. |
| `public/v1/materials/supplier-prices-publication.ts` | `suppliers.prices.update`: one supplier's costs from its price sheet (agent). |

## Data model

An **experience** (`experienceSchema`):

- `id`, `version`, `kind` (`overlay` | `modal` | `agentic`), `scope`
  (`organization`: done once for the company, such as a setup; `person`: once per
  person, such as a tour), optional `unit` (what the A/B bucket is keyed on;
  defaults to the scope) and `salt`.
- `title`, `description`, `tab` (the project tab app id it belongs to).
- `eligibility`: `capabilities` (each checked with `can`), `permissions` (each
  required, `a|b` allowed) and `when`, conditions over the chooser context.
- `triggers`: `before_action` (a selector; the click is held, the experience
  plays, then the click goes through), `tab_opened` (a project tab app id),
  `after_experience`, `manual`. Each has `once` and optional `when`.
- `variants`: `id`, `weight`, `when`, optional `kind` (a modal where the assistant
  is off), `steps` (an order or a subset) and `content` (options merged per step).
- `steps`. Overlay steps: `title`, `body`, `targets` (selectors left undimmed;
  the first found is highlighted), `placement`, `advance` (`next` or `click`),
  `wait_ms`. Setup steps: `widget` (a registered browser renderer), `title`,
  `subtitle`, `say` (the agent's lines, programmatic), `options` (fixed data) or
  `source` (filled on the server), `selects` (the keys it writes), `required`.
  Either kind may have `next`: a step id, or `branches` whose `when` reads
  `selections.*`, decided on the server with `work/conditions.ts`.
- `completion`: `action` (a published action run as the person with the
  selections as input, plus fixed `input`), `say`, and `then`: `handoff:
  assistant_tray`, `resume` (let the held click through), `play` (another
  experience).
- `replayable`: whether "show me again" may play it after it finished.
- `reveal`: onboarding sequencing, never access. `[{ tab, until: 'finished' |
  'completed', when: { "project.<fact>": value } }]`: until this person has
  finished the experience, the tab shows only on projects matching `when`. The
  list response carries the person's unfinished `reveals`; the project window
  filters its tabs with `FirstMateGuides.filterProjectTabs(apps, project)` (order
  and pills untouched) and redraws on `fm:guides:tabs-changed`. Someone who cannot
  play the experience is never held back. Project facts come from
  `FirstMateGuides.projectFacts`: `has_report` (a report delivered: a report link
  or file, or a completed report) and `is_draft`.

Copy is `{ key, text }`: a `PlatformLanguage` key in the `guided-experiences`
namespace and its English text. The browser resolves it through
`PlatformLanguage.text`, so the inline text is the fallback until a catalog
carries the key. A reworded text needs a new key.

**Tab FAQs** (`faqSchema`): per project tab, up to eight questions. `ask` sends
the question (or its `prompt`) to the assistant; `play` replays an experience
and is only offered when that experience exists for the person.

## Progress and analytics

`guided_progress` is one row per experience per subject: the organization
(`subject_id = ''`) or the person. It holds the variant, bucket, status
(`started`, `completed`, `dismissed`), the current step, the selections so far
(bounded, plain values, 16 KB) and, for an agentic setup, the conversation it is
bound to. A finished row stays finished; only a `replay` restarts it.

`guided_events` is append-only: `exposure` (once per unit), `start`,
`step_view`, `step_done`, `step_skip`, `back`, `dismiss`, `complete`, `replay`,
`question` (the person typed to the agent), `faq`. Every event carries the
experience version, variant, bucket and unit. Administrators read them at
`GET /v1/guided-experiences/organizations/:org/experiences/:id/events`. The
browser also sends each event to the existing analytics
(`FirstMateStatsig.track('guided_experience', …)`); no stream is opened.

## The chooser and A/B tests

`chooserContext` gathers: `organization.{id, state, region, timezone, size.users,
size.tier, industry, flags.assistant, flags.materials, finished}` (finished
organization experiences), `person.{id, role}` and `surface.{tab, project_id}`.
Navigation fields only choose content; they never authorize.

`chooseVariant`: the variants whose `when` matches, weighted, picked by
`bucketOf(unit, experience id, salt)`, a sha256 in [0, 1). The same unit always
gets the same variant; a new salt reshuffles. The variant someone was exposed to
is kept in their progress and stays while it still suits them, so changing
weights never moves people mid-experiment. Weight 0 keeps a variant defined but
off. To run an experiment: add a variant, give it weight, and compare outcome
events by `variant_id`.

Content choice is the same mechanism: the roofing setup's prices come from the
region the context resolves (`state`, then the census region, else national).

## Kinds and the runtime

**Overlay** (`FirstMateGuides.overlay.run`): an SVG mask dims the page with a
hole over each target; the hole slides between steps, a ring pulses on the
highlighted element, and the popover sits beside it with an arrow at the target (a
bottom sheet under 640px; a centred card with no arrow when a step has no target). Back, Next, Skip step, Skip tutorial
(the X), Escape and arrow keys. A step whose target never appears is skipped.
While a step shows, its target is followed every frame: when the person's action
moves it (a selection bar appears above it), the spotlight, ring and popover move
with it at once; when it goes away and its selectors match nothing, the step stays
as a centred card instead of pointing at whatever took its place.
The highlighted element can still be pressed; everything else is blocked. Above
the project window (`z-index` 2147483300) and `data-fmr-ignore`.

**Modal / agentic** (`guided-setup.js`): a sheet in front of a blurred dim, with
one close (X) at its top right that asks before skipping the setup. The step
widget is on the left and each new step rises into place as the last one lifts
away. The agentic kind puts the platform assistant itself on the right: a
`PlatformAssistant.mountProject` instance on the person's own project
conversation, the same component as the agent tray, running the setup as a
preprogrammed workflow (below). Each scripted turn (the person's choice in plain
words and the step's `say` lines) is written into that conversation on the server
(`POST …/conversation`) and shown in the assistant as it would type it. If the
person types, the assistant sends the turn to the real model in that thread: the
prepare hook adds `guidedConversationContext` (which setup, which step, the
choices so far, and to hand back to the steps and not write the price book
itself); after its answer the workflow says to carry on. On finish the
completion action runs and the hand-off plays as one choreographed transition
(`flyToTray`): one timeline (520 ms, `cubic-bezier(.65,0,.35,1)`) started on one
frame, in which the widget side shrinks onto the agent and fades, the backdrop
fades, the agent card (laid out once at its final size, then only transformed and
clipped) moves into the tray's rectangle, and the project window opens the tray
with the same duration and easing. The tray's own instance loads the same thread
underneath; the card fades only once the tray shows the conversation. Reduced
motion opens the tray at once. Each step change has one owner: a generation
counter removes every pane but the one on screen and stale animation callbacks
do nothing, so fast Back/Continue never stacks steps.
Under 760px the sheet fills the screen and the assistant folds below it behind an
Agent handle. `prefers-reduced-motion` turns every animation off. Without the
assistant (or without a project) the same steps play as a modal.

**Preprogrammed workflows in the assistant** (`platform-assistant.js`). A host
passes `workflow` when it mounts an instance (`mountProject`, `mountSurface`):
`onUserMessage(text)` sees a typed message first (return `true` to answer it
itself, otherwise the model answers); `onReply(message)` follows each model
answer; `onChoice(id, messageId)` receives a press on a choice. The instance adds
`say(lines)` (programmatic lines with the usual working indicator),
`post({ role, content, data })` and `sendWithFiles(text, files)` (attach and send
to the model); `data.choices: [{ id, label }]` draws choice buttons under a
message, and `data.upload: { label, message, accept }` draws an upload control
in the line: the file is attached and sent with `message` to the real model,
after `workflow.onUpload(files)` has run (the setup saves its draft there). A line the host also stored in the thread is not shown
twice when the conversation reloads. A workflow surface gets no tab questions.

Widgets are registered with `FirstMateGuidedSetup.registerWidget(id, { render(el,
{ step, options, selections, change, actions }) })`. `change(patch, summary)` merges a
selection patch and gives the plain summary the agent repeats in the person's
words (an empty summary posts nothing). `actions` is the step's title row, for a
control such as "Use all". A widget declared `fill: true` gets the step's height
(the logo grid, supplier columns); other steps scroll with a fade at the bottom
while there is more. `hint()` says why Continue is disabled, as its tooltip.
Steps can branch: the player follows a step's fixed `next` itself, waits for the
server's answer only after a step with `branches`, remembers the way taken (Back
returns along it) and draws the progress bar over that way. The finished screen
is centred and waits for one of its two buttons: "Start generating materials"
(closes, hands off, and the outcome's `generate` makes the runtime press the
tab's Generate when no click was held) and "View the price book", which shows the
price book renderer (`FirstMatePricebook.mount`, as Materials settings mounts it,
read again first, with `itemFilter` keeping the items the setup returned in
`item_ids`) in the sheet, widened, with the agent still beside it. Closing the
finish generates nothing. Widgets: `roof-types` (a drawing and a name per
kind), `brand-cards` (logos only, numbered in the order picked),
`material-defaults` (the defaults on one page), `default-material` (one system
of the kinds picked), `supplier-columns`, `labor-assignees`. A step's `upload`
puts an upload control in one of its `say` lines; its `agent_note` is added to
the model's context on that step.

**Supplier columns** (`supplier-columns.js`, reusable). `window.FirstMateSupplierColumns.mount(el,
{ suppliers, items, onChange, onPriceSheet })` draws one thin column per supplier
(brand colour on top, an initials badge, what it carries with a cost each, a
Price sheet button), two at a time in a native horizontal scroller (thin
scrollbar, trackpad, shift-wheel, snapping to a column). An arrow on each side
scrolls one column and shows only while there is more that way; both follow
the scroll position, however it moved. `priceSheet({ supplier, assistant, before })` asks for a file and
sends it to the assistant (an instance, or the global one) naming the supplier
and its id, so the agent sets that supplier's costs with `suppliers.prices.update`.
It stores nothing itself; the Materials settings can mount both.

**Triggers in the browser.** `before_action` is a capture-phase click listener:
it holds the click, plays, and after `then` clicks the element again with a
bypass (found again by its selector if the page redrew it). A dismissed setup
also lets the click through. `tab_opened` listens for `fm:project-tab:opened`,
which `tab-guides.js` `opened()` dispatches in the frame that shows the tab;
route changes only refresh what is offered. `after_experience` is the `play` in
`then`.

**One experience at a time.** The portal and every project window (an iframe of
the portal) load this library, so the lock and queue live on the top window
(`__fmGuidedLock`): a second request waits, the same experience asked for again
is ignored, and every play re-reads progress from the server first, so nothing
finished replays. Events are sent in order in the background; nothing on screen
waits for them. In a setup, Next moves at once (only a step with `branches`
waits for the server) and a burst of presses within 250 ms counts once; in a
tour, only the first step waits for its target, later missing targets are
skipped at once, and a newer move cancels an older one. Back works at any time.
`tab-guides.js` no longer plays its own tutorials when this library is present.

## Assistant suggestions

The first three questions show inline above the composer, the replay ("Show me
the tutorial again", with its play icon) first, and a More chip at the end of
that row opens the rest with a height animation (Less folds them). No sideways
scrolling.


`platform-assistant.js` calls `FirstMateGuides.attachAssistant(drawer, { getContext,
ask })` when it builds. The strip of questions for the current tab sits just above
the composer in every assistant instance (the project's agent tray, the global
assistant) and follows tab changes. "Show me the tutorial again" is a `play`
question.

## Materials: the first use

`definitions/materials.ts`:

- `materials.pricebook_setup.roofing` (agentic, organization). Eligible to
  people with `manage_company_settings` and `manage_projects` where
  `platform.materials` is on and the organization is roofing or has not said.
  Triggers: the first time they open the Materials tab (report or not, saved or
  draft: on a draft it plays as a modal, since there is no project conversation,
  and its write is organization-level, so nothing saves the project), and the
  Generate buttons for anyone the first view missed. Variants: `agentic` (assistant on),
  `agentic_express` (weight 0, no labor step), `modal` (assistant off).
  Steps: roof types ("What kinds of roofs do you install?", nine kinds, PVC apart
  from TPO), then a branch decided on the server. With shingle: manufacturers
  ("What roofing manufacturers do you use?", in the order picked) and the defaults
  ("Set your default materials", skippable). Without: the default material ("What's
  your default roofing material?", one of the systems of the kinds picked). Both
  then go to suppliers (who provides your materials, where costs are set per
  supplier) and labor (who does your labor; optional, and only where groups of
  users and outside companies are on). Completion: `pricebook.setup.apply` with
  `trade: roofing`, then the finish's two buttons, hand-off, the held (or
  requested) Generate, and the tour.
- `materials.tab_tutorial` (overlay, person, replayable): after the setup, or on
  first opening the tab once the organization has finished the setup (or straight
  away for someone not asked to set it up: `person.eligible`). Its `reveal`
  keeps Materials to projects with a delivered report until the person has been
  through it (or closed it); then Materials shows on every project, drafts too.
- FAQs for Materials, Photos, Docs, Reports, Customer Portal and Overview.

**Price book setup** (`pricebook/setups/roofing.ts`). Products, rules, regions and
the kinds of roof (`roof_types`, each naming its component systems) come from
`materials/roofing-research/roofing-catalog-2026.json`, read in its own schema, with
the roofing library as the fallback. Every manufacturer in the catalog is offered,
the four most installed first; a manufacturer's `logo` (a path under
`public/images/brands/roofing/`, checked by `logoPath`) shows in a common box on its
card, and the wordmark shows when there is none or it fails to load.

**With shingle**, every product of every picked manufacturer is written (all lines
and accessories, so it is searchable), with the common items and, when included,
labor and service lines. The defaults (`defaults`) are what generation uses when
no document has said otherwise, each a product from a dropdown:

- shingle: the first picked brand's flagship (`setup_flagship` in the catalog);
- underlayment, ice and water, ridge vent, intake vent, box vents: the first
  picked brand that makes one, its `setup_default` accessory else its first
  (another picked brand fills a gap, then a generic item); pipe boot: the generic
  lead boot first (`DEFAULT_SLOTS`, `slotDefault`);
- how far ice and water runs (`ICE_COVERAGE`): 18 in at eaves and rakes plus
  valleys (default), 36 in or 72 in at the eaves plus valleys, 36 in at the eaves
  only, valleys only, or none. The measurement rule counts 3 ft courses (half a
  course along eaves and rakes at 18 in, one down each valley); the price book
  formula the same widths in square feet, plus the 2/12 to 4/12 squares;
- the low-slope system: TPO unless they install other membranes and not TPO,
  from the first picked brand that makes one, else the generic membrane from
  the roof-type components; modified bitumen is a base and a cap sheet from the
  same company (`low_slope_cap` labelled membrane or cap sheet, `low_slope_base`
  off for a single ply). "None" switches both off;
- starter, drip edge and hip and ridge need no question: they follow the shingle's
  manufacturer as before, and the coloured starter is the starter rule's
  `alternatives` entry when the shingle has `reveals_starter`.

The step asks no waste or formulas. Pipe boots and box vents are counted on the
roof, which no dictionary measurement holds, so their default is recorded on the
item (`metadata.default_for`) and entered by hand on each job; intake vents run
along the eaves (`intake_vent` rule, added beside the ridge vent). Each quantity
formula comes from the research rule's `pricebook_formula`, uses dictionary keys
only and is divided by that product's own coverage (an Owens Corning bundle
covers 32.8 sq ft; a WeatherWatch roll 2 squares).

**Without shingle** there is no manufacturer catalog. The roof-type components
(`materials/roofing-research/roof-type-components-2026.json`, `status:
provisional`: per system, components with a group, `standard`, dictionary `terms`,
`waste_percent`, a unit and its coverage, or `entered_by_hand`) are written as
price book items (`rtc-<system>-<key>`, cost 0 until a price sheet sets it) for
every system of every kind picked, standard or not, so they are searchable. The
default material's standard, measured components become its measurement-default
rules (`<system>_<key>`, the same rule model as shingles); the other rules stay,
switched off, and a later shingle setup starts from the industry rules again.
Components of the other kinds picked with shingle are written as items only.
Every step carries the whole options object; that is a known cost in the
[optimization backlog](../optimization-backlog.md#the-price-book-setup-sends-its-options-once-per-step).

Both are written through their own writers (`saveOrganizationCatalog`,
`saveMeasurementDefaults`). Prices are costs: research cost x the region's
material multiplier (labor uses the labor multiplier). A material's cost comes
from the supplier columns (`supplierItemCosts`): a cost typed in a supplier's
column (the first chosen supplier that carries the item), else the price seen
at that supplier, else the typical cost. The
setup writes no markup: it sets `internal_cost` (what the company pays) and
`unit_price` to the same cost; selling prices and margins belong to documents and
pricing settings. A cost a price sheet set (`metadata.price_source: price_sheet`)
is kept when the setup is finished again.

**Price sheets.** The suppliers step offers an upload in the agent's line
("If you have a price sheet from your supplier…"). Before the file goes to the
model, the setup saves what is chosen so far through the completion action (the
draft), so the agent finds the items. The agent reads them with
`pricebook.prices.list` and applies a checked list with `pricebook.prices.update`
(costs, never a markup; it asks before an uncertain match). Lines that match
nothing (usual for metal, tile, slate and flat roofs) are added, once the person
agrees, with `pricebook.items.add` (merged by name with an item already there,
`metadata.added_from: price_sheet`, entered by hand until a rule names them), and
the apply's `item_ids` include them. A sheet that names a supplier also sets that
supplier's costs (`suppliers.prices.update`).

**Suppliers.** With shingle, the suppliers step offers the researched suppliers in
`materials/roofing-research/roofing-suppliers-2026.json` (which manufacturers each
stocks, `full_range` or `retail_core`, a brand colour, observed library prices)
as pills, and any typed supplier as a tag. A researched supplier starts with the
picked brands' products it stocks (a big-box store only default lines and
plain accessories); a typed one starts empty. Without shingle nothing is
suggested: suppliers are typed, and each column keeps its own price sheet upload,
as that is how their items arrive. On finish each supplier is saved
through `suppliers.supplier.save`, invoked as the person, merged by name with a
supplier already saved: of the setup's items it carries the ticked ones; prices
are a typed cost, else one already saved (a price sheet), else the observed
price. A supplier's price sheet goes to the agent with the supplier's id, which
sets its costs with `suppliers.prices.update`. No supplier logos ship (they need
each company's permission). Another
trade plugs in with a `TradeSetup` in `pricebook/setups/index.ts` and its own
experience definition.

**Who does your labor** (`labor/labor-setup.ts`, widget `labor-assignees`, source
`labor.setup`). Labor is installed by a group of users (employees) or an outside
company (a subcontractor). The step shows the organization's groups and outside
companies (suppliers are not) as cards in two columns, and adds new ones by name
as either kind; what each kind is called comes from the terminology system
(`workforce.resource_group_singular`, `workforce.organization_connection_singular`).
A card sets the type (a group's one type, a company's type) and how it is paid for
roofing: a piece rate on a roofing measurement (per square by default), hourly, or
per job. That is saved as a one-line pay sheet through `pay-sheets.sheet.save`
([pay sheets](pay-sheets.md)); a sheet with more than one line or another way of
paying is shown as such and left to People. Each card's **Pay sheet** button sends
that party's rate card to the agent, after the draft adds them, naming their
assignee key; the agent writes their pay sheet (`pay-sheets.try`, then
`pay-sheets.sheet.save`) and never works out pay. On finish the setup invokes
`labor.setup.apply` as the person: new groups and companies through the writers
People uses (`createResourceGroup`, `createOrganizationConnection`), a changed type
through `assignees.profile.set`, pay through `pay-sheets.sheet.save`. It needs
`manage_company_settings`, `platform.materials` and `apps.crew`. Pay rules (what a
payee is paid for committed work, payroll) are not set here.

The step has its own `eligibility` (a step-level capabilities and permissions
list, checked like an experience's): `apps.crew`, `platform.people_access`,
`platform.expanded_access`, `platform.materials` and `manage_company_settings`.
A person without them plays the setup without it, and labor stays plain lines.

**The Labor column.** Skipping the step saves `shown: with_assignees` on the
Labor resource type (`materials.resource-type.update`, as the person). With that
setting the column, and the labor lists a scope generates, wait until there is
someone to do labor: an active group, an active outside company that is not only
a supplier, or anyone with a pay sheet; or while any labor list exists, so no work
is hidden (`laborColumnShown` in `materials/resource-types.ts`). Adding a group,
a subcontractor or a pay sheet brings it back with nothing else saved. With
nothing saved, or `shown: always` (turning it on by hand), it shows as it always
has; where `apps.crew` is off it always shows. The setting is data on the
organization's Labor type, never a configuration check.


## Tab tours: Photos, Reports, Customer Portal

One overlay tour per tab, each in its own file under `definitions/` and
registered in `ensureGuidedDefinitions`: `photos.tab_tutorial` (`photos.ts`,
`project.photos`, `platform.project_photos`), `reports.tab_tutorial`
(`reports.ts`, `project.measurements`, `apps.firstmeasure`) and
`customer_portal.tab_tutorial` (`customer-portal.ts`, `project.customer_portal`,
`platform.customer_portal`). Each is per person and replayable, plays on the
first `tab_opened` of its tab wherever the tab's capability is on, and has an
intro, its steps on the tab's own hooks (a step whose control is not on the
page, such as a report's model before it is ready, is skipped) and an outro
pointing at "Show me the tutorial again". That replay question is added to the
tab's existing questions with `addTabFaqs`, which merges with
`registerTabFaqs` in either order and keeps the limit of eight; a file never
edits another file's questions. There is no Docs tour yet: the Documents tab
is being reworked first. `tests/guided-tab-tours.test.ts` checks the data and
that every target's hooks are in the tab's source;
`tests/guided-tab-tours-browser.test.ts` plays each tour against the real
service.

## Agents can press the buttons

`pricebook.setup.apply` (organization, `manage_company_settings`) and
`materials.project.generate` (project, `manage_projects`, `platform.materials`)
are published actions, so an agent asked to "generate the materials list" calls
the same service the button does (defaults generation, then lists rebuilt from
the scope).

Materials tab audit (October 24), button to published action:

| Tab action | Published action |
|---|---|
| Generate / regenerate materials | `materials.project.generate` (new) |
| Generate a signed document's set | `materials.calculus.command` evaluate + apply |
| Calculus sets: create, amend lines, configure, retire, order, delivery, receive | `materials.calculus.command` |
| Purchase order, shopping list | `materials.purchase_order.write`, `materials.shopping_list.create` |
| Resource-type columns | `materials.resource-type.*` |
| Labor list from a pay sheet | `labor.list.generate` |
| Requirements, manual scope | `work-requirements.manual.save` |
| Pay out, reopen, close out | `labor.list.finalize`, `labor.list.reopen`, `project-closeout.*` |
| Set up the price book | `pricebook.setup.apply` (new) |
| Apply a supplier price sheet to the price book | `pricebook.prices.list`, `pricebook.prices.update` (new) |
| Add a price sheet's items the price book does not have | `pricebook.items.add` (new) |
| Set a supplier's costs from its price sheet | `suppliers.prices.update` (new) |
| Older (non-calculus) lists: add list, rename, delete, add or edit lines, mark ordered, mark delivered | missing: plain routes in `materials/api.ts` |
| Email a supplier order, share a shopping list, PO PDF, schedule a list's delivery, work order document, labor preview/compare | missing |

## Authoring

1. Write the definition in `definitions/<domain>.ts` with `registerExperience`;
   register it from `ensureGuidedDefinitions` in `service.ts`.
2. Copy: new `gx_…` keys for every text.
3. Overlay targets: stable attributes (`data-…`), never generated classes. A step
   whose target is missing is skipped, so a tour survives a hidden button.
4. Setups: a widget per step; data from a `registerGuidedSource` on the server;
   what is written is a published action named in `completion.action`.
5. Pick eligibility (capabilities and permissions, not configurations) and
   triggers; add a variant for anything that should differ by context.
6. Tests: `tests/guided-experiences.test.ts` (engine),
   `tests/pricebook-roofing-setup.test.ts` (the roofing setup) and
   `tests/guided-experiences-browser.test.mjs` (overlay, setup, hand-off, FAQs,
   replay, phone width) and `tests/guided-experiences-flow-browser.test.mjs`
   (portal plus project frame: one experience at a time, fast Next and Back,
   close mid-tour, reopen, reload, switch projects, the tray's lines once, dev
   editing) and `tests/guided-experiences-dev.test.ts` (dev gating, overrides,
   history, export, reset). Set `GX_SHOTS=<dir>` to save screenshots.

## Development: reset, replay and editing copy

Development data environment only (`env.dataEnvironment === "development"`, never
production): `guided-experiences/dev.ts`. Who: a platform administrator (an active
internal admin, as session replay decides) or the development tools audience (a
settings manager in a sandbox test organization, as the dev bar's tools). Every
route refuses elsewhere with 404, whoever asks.

- **Reset** (`POST …/organizations/:org/dev/reset { experience_id, scope: me |
  organization }`): clears progress (which also brings back a reveal), the
  exposure that counted it, and its scripted lines in conversations (`line_key`
  prefix), so it plays as new. The price book a setup wrote stays. **Replay**
  plays a tour again; **Restart** resets a setup for me and plays it from step 1.
- **Copy** (`PUT /dev/copy`, `GET /dev/copy/history?key=`, `POST /dev/copy/revert`):
  every piece of copy rendered through `copyHtml` carries its language key; for a
  development editor it is plain-text `contenteditable` and saves 700 ms after
  typing (or on leaving the field). Overrides are platform-wide, keyed by the
  copy's `gx_` language key (with the experience, step and field where it was
  edited, for the record), applied over the definitions' English for everyone in
  development on their next load. Each change is a revision with its author and
  time; revert to any revision or back to the code's text. Markup is refused,
  everything is shown as text. Scripted agent lines are editable in the assistant
  too (their message carries `copy_key`); lines already stored in a conversation
  keep the text they were written with.
- **Languages:** overrides are English only. They replace a key's English (also
  over a catalog entry, when there is one); other languages keep their
  translation. Production reads no overrides and shows the code's copy.
- **To code:** `GET /v1/guided-experiences/dev/copy/export` returns each override
  beside the source text it replaces (`definitions/*.ts`, the guided libraries) and
  the same text as `guided-experiences` catalog entries. Save it and run
  `node public/v1/scripts/guided-copy-apply.mjs export.json --write`, review the
  diff, commit; then revert the overrides on dev to the code's text. A key whose
  English the catalog already carries needs the catalog entry updated too.
- **Seeing it:** copy editing is off until the editor turns it on in the pill
  (remembered per browser); then editable copy has a dashed outline. The pill sits
  at the bottom left of the screen, just right of the portal sidebar, folds to a
  "GX" handle, says "Editing copy" and
  its menu holds the last field's history and each experience's Replay or
  Restart, Reset me and Reset org. The development tools window gets the same
  section. Everything is `data-fmr-ignore`.

## Limits (prototype)

- The scripted turns are stored in English; the person sees their own language.
- Branch conditions are evaluated on the server when a step is done; there is no
  client-side preview of a branch.
- `tab-guides.js` still plays its own minimal tutorials; moving them onto this
  runtime is the next step (docs/architecture/project-tab-guides.md lists them).
- Regional multipliers and many prices are estimates (see the research README).
- With nobody to do labor yet, the Labor column's rule reads every material list
  ([optimization backlog](../optimization-backlog.md#the-labor-column-reads-every-material-list-when-nobody-does-labor)).
