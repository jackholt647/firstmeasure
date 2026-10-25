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
completion action runs, the sheet closes and the assistant column flies to where
the project's agent tray opens; the tray's own instance loads the same thread.
Under 760px the sheet fills the screen and the assistant folds below it behind an
Agent handle. `prefers-reduced-motion` turns every animation off. Without the
assistant (or without a project) the same steps play as a modal.

**Preprogrammed workflows in the assistant** (`platform-assistant.js`). A host
passes `workflow` when it mounts an instance (`mountProject`, `mountSurface`):
`onUserMessage(text)` sees a typed message first (return `true` to answer it
itself, otherwise the model answers); `onReply(message)` follows each model
answer; `onChoice(id, messageId)` receives a press on a choice. The instance adds
`say(lines)` (programmatic lines with the usual working indicator) and
`post({ role, content, data })`; `data.choices: [{ id, label }]` draws choice
buttons under a message. A line the host also stored in the thread is not shown
twice when the conversation reloads. A workflow surface gets no tab questions.

Widgets are registered with `FirstMateGuidedSetup.registerWidget(id, { render(el,
{ step, options, selections, change }) })`. `change(patch, summary)` merges a
selection patch and gives the plain summary the agent repeats. First ones:
`brand-cards`, `product-lines`, `measurement-rules`, `price-review`.

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

The questions wrap into rows above the composer, the replay ("Show me the
tutorial again", with its play icon) first; more than two rows fold behind
"More". No sideways scrolling.


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
  `agentic_express` (weight 0, no rules walkthrough), `modal` (assistant off).
  Steps: brands, lines, rules (how a roof becomes a list), prices. Completion:
  `pricebook.setup.apply` with `trade: roofing`, then hand-off, the held Generate,
  and the tour.
- `materials.tab_tutorial` (overlay, person, replayable): after the setup, or on
  first opening the tab once the organization has finished the setup (or straight
  away for someone not asked to set it up: `person.eligible`). Its `reveal`
  keeps Materials to projects with a delivered report until the person has been
  through it (or closed it); then Materials shows on every project, drafts too.
- FAQs for Materials, Photos, Docs, Reports, Customer Portal and Overview.

**Price book setup** (`pricebook/setups/roofing.ts`). Products, rules and regions
come from `materials/roofing-research/roofing-catalog-2026.json`, read in its own
schema, with the roofing library as the fallback. Every manufacturer in the catalog is offered,
the four most installed first; a manufacturer's `logo` (a path under
`public/images/brands/roofing/`, checked by `logoPath`) shows in a common box on its card, and the
wordmark shows when there is none or it fails to load. The selections become:

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
- **Seeing it:** editable copy has a dashed outline; a pill at the bottom left
  says "Editing copy" (press to see the clean view; remembered per browser) and
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
