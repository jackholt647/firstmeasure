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
| `public/v1/guided-experiences/registry.ts` | `registerExperience`, `registerTabFaqs`, `registerGuidedSource`. A malformed definition stops the server. |
| `public/v1/guided-experiences/chooser.ts` | Deterministic bucketing and variant choice; region and size helpers. |
| `public/v1/guided-experiences/store.ts` | SQL store `guided-experiences`: `guided_progress`, `guided_events`. |
| `public/v1/guided-experiences/service.ts` | Eligibility, resolving for a person, events, completion, the scripted conversation, the assistant hook. |
| `public/v1/guided-experiences/api.ts` | Routes under `/v1/guided-experiences`. |
| `public/v1/guided-experiences/definitions/*.ts` | Domain definitions. `materials.ts` holds the first ones. |
| `public/libraries/guided-experiences/guided-experiences.js` | `window.FirstMateGuides`: API client, triggers, the overlay engine, assistant FAQs. |
| `public/libraries/guided-experiences/guided-setup.js` | `window.FirstMateGuidedSetup`: the `modal` and `agentic` players and step widgets. |
| `public/v1/pricebook/setups/` | Price book setups by trade and the `pricebook.setup.apply` action. Roofing is the first. |

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
highlighted element, and the popover sits beside it (a bottom sheet under 640px,
a centred card when a step has no target). Back, Next, Skip step, Skip tutorial
(the X), Escape and arrow keys. A step whose target never appears is skipped.
The highlighted element can still be pressed; everything else is blocked. Above
the project window (`z-index` 2147483300) and `data-fmr-ignore`.

**Modal / agentic** (`guided-setup.js`): a sheet in front of a blurred dim. The
step widget is on the left and each new step rises into place as the last one
lifts away. The agentic kind adds the conversation on the right: the step's
`say` lines appear with a typing indicator. Each scripted turn (the person's
choice in plain words and the step's lines) is also written into the person's
own project conversation (`POST …/conversation`, `project:<id>` thread), so the
agent tray later holds it. If the person types, the real assistant answers in
that thread: the assistant's prepare hook adds `guidedConversationContext`
(which setup, which step, the choices so far, and to hand back to the steps and
not write the price book itself). On finish the completion action runs, the
sheet closes and the conversation flies to where the project's agent tray opens;
the tray loads the same thread. Under 760px the sheet fills the screen and the
conversation folds below it. `prefers-reduced-motion` turns every animation off.

Widgets are registered with `FirstMateGuidedSetup.registerWidget(id, { render(el,
{ step, options, selections, change }) })`. `change(patch, summary)` merges a
selection patch and gives the plain summary the agent repeats. First ones:
`brand-cards`, `product-lines`, `measurement-rules`, `price-review`.

**Triggers in the browser.** `before_action` is a capture-phase click listener:
it holds the click, plays, and after `then` clicks the element again with a
bypass. A dismissed setup also lets the click through. `tab_opened` reads the
route (`project`, `projectTab`) on `fm:route-state:updated`. `after_experience`
is the `play` in `then`.

## Assistant suggestions

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
  Trigger: the Materials tab's Generate buttons. Variants: `agentic` (assistant on),
  `agentic_express` (weight 0, no rules walkthrough), `modal` (assistant off).
  Steps: brands, lines, rules (how a roof becomes a list), prices. Completion:
  `pricebook.setup.apply` with `trade: roofing`, then hand-off, the held Generate,
  and the tour.
- `materials.tab_tutorial` (overlay, person, replayable): after the setup, or on
  first opening the tab once the organization has finished the setup.
- FAQs for Materials, Photos, Docs, Reports, Customer Portal and Overview.

**Price book setup** (`pricebook/setups/roofing.ts`). Products, rules and regions
come from `materials/roofing-research/roofing-catalog-2026.json`, read in its own
schema, with the roofing library as the fallback. The selections become:

- price book items for the chosen lines, the default line's brand's system
  accessories (another chosen brand fills a gap), the common items, and labor and
  service lines when included. Each quantity formula comes from the research rule's
  `pricebook_formula`, uses dictionary keys only (`roofSquares - flatRoofSquares`,
  never `shingleSquares`) and is divided by that product's own coverage (an Owens
  Corning bundle covers 32.8 sq ft; a WeatherWatch roll 2 squares). The ice and
  water eave width (6, 3 or 0 ft) is the company's. A rule that reads something the
  dictionary does not hold (pipe boots, stories, decking sheets) gets no formula and
  is marked `quantity: entered_by_hand`.
- the measurement defaults (`materials/measurement-defaults.ts`) with each rule
  naming its product and package; shingle waste is the company's (worked out per
  roof, or a fixed percent).

Both are written through their own writers (`saveOrganizationCatalog`,
`saveMeasurementDefaults`). Prices: research cost x (1 + markup) x the region's
material multiplier; labor uses the labor multiplier; typed prices win. Another
trade plugs in with a `TradeSetup` in `pricebook/setups/index.ts` and its own
experience definition.

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
   replay, phone width). Set `GX_SHOTS=<dir>` to save screenshots.

## Limits (prototype)

- The scripted turns are stored in English; the person sees their own language.
- Branch conditions are evaluated on the server when a step is done; there is no
  client-side preview of a branch.
- `tab-guides.js` still plays its own minimal tutorials; moving them onto this
  runtime is the next step (docs/architecture/project-tab-guides.md lists them).
- Regional multipliers and many prices are estimates (see the research README).
