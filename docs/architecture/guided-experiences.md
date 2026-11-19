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
| `public/v1/guided-experiences/registry.ts` | Reads experiences and tab FAQs from the [config library](config-library.md) (kinds `guided_experience`, `guided_tab_faqs`; derives `setup_step.<id>`), parsed once per library change; `registerGuidedSource`. |
| `public/v1/guided-experiences/sources.ts` | The guided sources (code), registered by id: `pricebook.roofing_setup`, `labor.setup`, `operations.suppliers`, `operations.workforce`. |
| `public/v1/config-library/kinds/guided_experience.ts`, `guided_tab_faqs.ts`, `setup_step.ts`, `guided_copy.ts` | The library kinds: schema and the checks a save must pass (sources, actions, capabilities, setup steps and experiences it names). |
| `public/v1/guided-experiences/chooser.ts` | Deterministic bucketing and variant choice; region and size helpers. |
| `public/v1/guided-experiences/store.ts` | SQL store `guided-experiences`: `guided_progress`, `guided_events`. |
| `public/v1/guided-experiences/service.ts` | Eligibility, resolving for a person, events, completion, the scripted conversation, the assistant hook. |
| `public/v1/guided-experiences/api.ts` | Routes under `/v1/guided-experiences`. |
| `public/libraries/guided-experiences/guided-experiences.js` | `window.FirstMateGuides`: API client, triggers, the overlay engine, assistant FAQs. |
| `public/libraries/guided-experiences/guided-setup.js` | `window.FirstMateGuidedSetup`: the `modal` and `agentic` players and step widgets. |
| `public/v1/pricebook/setups/` | Price book setups by trade and the `pricebook.setup.apply` action, plus `pricebook.prices.list` / `pricebook.prices.update` for price sheets. Roofing is the first. |
| `public/v1/documents/setup.ts`, `public/libraries/guided-experiences/documents-setup.js` | The document setup (below): `document-setup` data, `documents.setup.apply`, its steps. |
| `public/libraries/guided-experiences/supplier-columns.js` | `window.FirstMateSupplierColumns`: supplier columns and the supplier price sheet hand-off, mountable anywhere. |
| `public/v1/materials/supplier-prices-publication.ts` | `suppliers.prices.update`: one supplier's costs from its price sheet (agent). |

Setup steps, questions answered once and required by any setup ("What kind of company are you?"),
are part of this runtime: see [setup steps](setup-steps.md).

## Data model

An **experience** (`experienceSchema`):

- `id`, `version`, `kind` (`overlay` | `modal` | `agentic` | `announcement`), `scope`
  (`organization`: done once for the company, such as a setup; `person`: once per
  person, such as a tour), optional `unit` (what the A/B bucket is keyed on;
  defaults to the scope) and `salt`.
- `title`, `description`, `tab` (the project or portal tab app id it belongs to).
- `intro` (a setup's line above its first page, whichever step that is, saying why it asks) and `skip_note` (what its
  "Skip setup for now?" question says happens next, where the general text, about Materials, does not fit).
- `eligibility`: `capabilities` (each checked with `can`), `permissions` (each
  required, `a|b` allowed) and `when`, conditions over the chooser context.
- `triggers`: `before_action` (a selector; the click is held, the experience
  plays, then the click goes through), `tab_opened` (a project tab app id, or a
  portal tab's such as `portal.scheduling`; with `skip: "later"` a skip only puts
  it off, below, and its `skip_note` says when it is asked again),
  `after_experience`, `app_loaded`, `workflow_opened` (a `document_type`: a document
  workflow opened for that kind of document), `panel_opened` and `panel_closed` (a
  project window `panel` that is not a tab, `project.details` for the details tray,
  opened, or closed by the person; optional `covering`: only where it does, or does
  not, cover the page), `manual`. Each has `once` and optional `when`.
- `variants`: `id`, `weight`, `when`, optional `kind` (a modal where the assistant
  is off), `steps` (an order or a subset) and `content` (options merged per step).
- `steps`. Overlay steps: `title`, `body`, `targets` (selectors left undimmed;
  the first found is highlighted), `placement`, `advance` (`next` or `click`),
  `wait_ms`, and `cases` for an element that can be in more than one state: each
  case has its own `targets` and optional `title`/`body`, and the first case found
  on the page decides where the step points and what it says, so the copy names
  only what is on screen and the tour still shows one dot for the step (the
  project details tour's Measurements step has a case for each set of buttons the
  ordering widget offers, `data-measurement-options`). Setup steps: `widget` (a registered browser renderer), `title`,
  `subtitle`, `say` (the agent's lines, programmatic), `options` (fixed data) or
  `source` (filled on the server), `selects` (the keys it writes), `required`.
  Either kind may have `next`: a step id, or `branches` whose `when` reads
  `selections.*`, decided on the server with `work/conditions.ts`. Either kind
  may have `eligibility` (`capabilities`, `permissions`, each required, `a|b`
  either), checked like an experience's when it is resolved: a step the person
  cannot have is never sent, so a setup plays without it and a tour never points
  at a feature the organization has off.
- `completion`: `action` (a published action run as the person with the
  selections as input, plus fixed `input`), `say`, and `then`: `handoff:
  assistant_tray`, `resume` (let the held click through), `play` (another
  experience; with `held: false` only when no click was held, `held: true` only
  after one).
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

**Definitions are config library data.** Every experience is a `guided_experience`
entry (id = experience id), every tab's questions a `guided_tab_faqs` entry (id =
tab app id) and every setup step a `setup_step` entry, edited on dev and checked in
as the library snapshot ([config library](config-library.md)); there are no
definition files. Organizations keep no copies: the runtime reads the library live.
What an entry names that is code stays code, registered by id: guided sources
(`sources.ts`), completion actions (published actions), step widgets and modules
(browser). A save that names one the running code does not register is refused.

Copy is `{ key, text }`: a `PlatformLanguage` key in the `guided-experiences`
namespace and its English text, as the library holds it. In English the browser
shows that text over any catalog English for the key, so an edit in the library
shows at once; other languages resolve through `PlatformLanguage.text` (the inline
text is the fallback until a catalog carries the key). A reworded text still wants
a new key, so translations are redone.

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
`question` (the person typed to the agent), `faq`, `defer` (a skip put off for
later, below).

**Skipping for later** (FM-553). A setup can be offered before it is needed: the
appointments setup plays the first time someone opens the Scheduling tab
(`tab_opened` `portal.scheduling` with `skip: "later"`), not only on New
Appointment (`before_action`). A skip of what such a trigger started records
`defer`, not `dismiss`, with a hash of the platform session it was made in, and
progress stays `started`. Then that trigger is used up, and while the person is
still in the same platform session and within an hour of the skip, the
experience's other triggers are not armed either (they have just said "not
now"); after that the first of them plays it as usual, and a skip there is an
ordinary `dismiss`. Setup steps answered before the skip stay answered, so it
asks only what is still unknown. This is the one other place events are read to
decide behavior (`lastEvent`), besides counting an exposure once. Every event carries the
experience version, variant, bucket and unit. Administrators read them at
`GET /v1/guided-experiences/organizations/:org/experiences/:id/events`. The
browser also sends each event to the existing analytics
(`FirstMateStatsig.track('guided_experience', …)`); no stream is opened.

## The chooser and A/B tests

`chooserContext` gathers: `organization.{id, state, region, timezone, size.users,
size.tier, industry, industry_sets, company_type, services, flags.assistant,
flags.materials, finished}` (finished organization experiences), `person.{id, role}`
and `surface.{tab, project_id}`. Navigation fields only choose content; they never
authorize.

**Different by kind of company.** A setup, variant or page that differs by trade reads
the company profile ([setup steps](setup-steps.md), "Industry sets"), never a list of its
own: `organization.industry_sets` contains a set from the company-profile catalog
(`roofing_exteriors`), or `organization.company_type` / `organization.services` name
catalog ids. A save naming a set, type or service the catalog does not have is refused.
Per-trade content is a variant with that `when` and its own `content` for the step's
options, so it shows in the dev console's **What drives setup** diagram
([dev console](dev-console.md)).

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
The sheet is a wide landscape rectangle (960px modal, 1120px agentic) as tall as
the step on screen: the player measures the step's own content (the pane let go of
the stage's bottom edge) into `--gxs-fit` whenever it changes size, and the CSS
caps it at `min(760px, --gx-vh - 32px)` (the visible height, below), past which the step scrolls. A step that
fills (`data-fill`) has no fit and takes the full height; the agentic sheet keeps
at least 600px for the conversation. Under 760px a modal setup is a sheet from the
bottom edge, as tall as its step but never under two-thirds of the visible screen
(a short step sits in the middle of the extra room, FM-484); the agentic one fills the screen and the
assistant folds below it behind an Agent handle. On a phone a setup has one title, in its top bar between the agent
and the X (with the step's (i) explanation), instead of a badge row and a title row (FM-486); the step keeps only its
title actions. `prefers-reduced-motion` turns every animation off. Without the
assistant (or without a project) the same steps play as a modal.

**One scroller.** A player that covers the page (a setup sheet, an announcement)
calls `FirstMateGuides.holdPage(cover)` while it is up. The page under it no longer
scrolls (`html` and `body` `overflow: hidden`, `overscroll-behavior: none`), and
the cover follows the visual viewport: on a phone the keyboard shrinks what is
visible but not the page, so the cover's `top` and `height` and its CSS variable
`--gx-vh` become the visible screen, and every sheet height is calculated from
`--gx-vh`, never `100vh`/`100dvh`. The sheet and its steps are
`overscroll-behavior: contain`, so a step at the end of its scroll never hands the
drag on. Nothing inside a step is: a row that clips or a field is a scroll
container too, and contained it would swallow the wheel over it (FM-605, the
scope builder's line items), so it passes the wheel on to the step. Before this (FM-365) a phone had two scrollers, the page panning behind
the keyboard and the step, and a drag that landed on the one already at its end
moved nothing. A new kind that covers the page uses the same hold; overlay tours
do not, because they point at the page and it must scroll to their targets.

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
control such as "Use all". `setTitle(text)` replaces the title in the top bar while the step shows something with a
name of its own (the Operations workflow publishes its current step's title through the workflow's `onStepTitle`, so a
phone shows "What are we working on?", not that over "What does this project need?"); an empty text restores the
step's title. On a phone the Operations workflow also puts its step numbers in one row along the bottom
(`phoneSteps: 'bottom'`) and folds its pinned proposal preview to a bar that opens and closes it, open by itself on
the review step (`preview.collapsible`). A widget declared `fill: true` gets the full sheet height
(the logo grid, supplier columns, the Operations workflow); a widget may switch it
by toggling `data-fill` on its step (the supplier step fills only once it has
columns). Other steps make the sheet as tall as they are and scroll with a fade at
the bottom past the cap. Do not size the sheet per guide. `hint()` says why Continue is disabled, as its tooltip.
Steps can branch: the player follows a step's fixed `next` itself, waits for the
server's answer only after a step with `branches`, remembers the way taken (Back
returns along it). The phone's back control (Android back, iOS swipe) is that
Back (FM-554): the sheet keeps one history entry per step behind the one on
screen plus one for its first step, through `Portal.navigation.steps()` (in
`navigation/portal-navigation.js`, the page's one owner of `window.history`;
the phone booking steps use it too). Entries are on the page's own URL, are
added only after a tap or key (Chrome skips entries added without one), never
re-apply the route, and come off when the sheet closes. Back on the first step
asks to skip, as the X does; with that question open it is Keep going; on the
finish it closes. Do not call `history.pushState` for steps yourself.
There is no step count or progress bar: a setup's length is not
known ahead ([setup steps](setup-steps.md) it requires are asked only while
unanswered), so the frame only goes on to the next step. The finished screen
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
`then`. `workflow_opened` listens for `fm:doc-workflow:opened`, which `FMDocWorkflow.mount`
dispatches in its own frame with the document its host names (`document: { id, type }`; the
documents app passes the document's `document_type`). It plays once that workflow is laid out
and nothing covers it (checked with `elementFromPoint`), so the documents New dialog (z-index
2147483530, above the tour layer) closes first; a hidden host never starts it, and a play still
queued when the workflow goes away is dropped (`options.showing`). `panel_opened` and
`panel_closed` listen for `fm:project-panel:opened` and `fm:project-panel:closed`, which the
project window dispatches when the details tray opens or closes (`project-request/app.js`
`announceDetailsTray`) with `{ panel, covers, user, isOpen(), covering() }`. `panel_closed`
plays only on the person's close (`user`), and a play is dropped if the panel is open again
before it starts.

**A panel that covers the page holds the tab's tour.** On a phone the details tray is a
sheet over the whole window, so the tab under it is not what the person sees. While a
panel's `covering()` is true, a tab announced meanwhile is not armed, and a visit already
armed is suspended exactly as leaving it would (its timer and queued play cancelled, a tour
on screen ended quietly, so it plays again); when the panel closes, the visit is armed
again. What the close plays (its `panel_closed` experience) is asked for first, so the
tab's tour follows it in the queue.

**Preload and instant tab tours.** As soon as a frame knows its project (the
first read, `fm:project-modal:hydrated`, or `FirstMateGuides.preload(projectId)`)
it reads the list once and keeps it in memory, per organization, person and
project (never browser storage). The list is the server's: only experiences this
person may see, with step eligibility applied, their progress, triggers and copy
overrides, for every tab. So when a tab is announced the runtime knows
synchronously whether a tour is still to play there. A tour (overlay) then
starts at once, with no `delay_ms` and no network wait: the scrim and its first
step are drawn in the frame of the announcement (a first step with a target
waits only for that target; the first targeted step of a tour gets the one
`wait_ms` wait, so a centred intro does not use it up). The server confirms in
the background: progress is read again and only then are `exposure` and `start`
sent; every event the tour sends waits for that answer and keeps its order. If
the server says the tour is no longer to play (finished in another tab, not
offered any more) or the route by then names another tab, it fades away and
nothing is recorded. A tour the tab change ended before the answer records
nothing either. A setup (modal, agentic) never draws before the server confirms
it, so it cannot flash: it uses the preload only to skip the list read, and
keeps its `delay_ms` and the progress read before it draws. A tour finished in
this frame is marked finished in the preload at once. Without a preload yet
(the window opened straight on a tab), the tab waits for the project's list and
then does the same.

**A tab's trigger plays only on its tab.** A visit is one stretch on one tab of
one project, from its `fm:project-tab:opened` until another tab or project is
announced, or a route change finds the host's `isActive()` false (another tab,
the window closed). A `tab_opened` trigger, and the `after_experience` play that
follows a setup, belong to the visit they were armed in (`onItsTab`): leaving
cancels the delay's timer, takes the play off the shared queue, and drops a play
still reading progress, which is asked again once the server answers. Every new
visit arms again, so a dropped trigger plays on the next real visit of its tab.
A tab's overlay tour that is playing when the tab changes ends quietly (status
`ended`: no `dismiss`, no `complete`, progress stays `started`), so it plays
again next time; this holds for a replay too. A tour already on the tab a
frame's first announcement names (a replay started before it) carries on. A setup (modal or agentic) covers
the page and writes for the organization, not the tab, so it carries on; only
the tour after it is held to the tab.

**One experience at a time.** The portal and every project window (an iframe of
the portal) load this library, so the lock and queue live on the top window
(`__fmGuidedLock`): a second request waits, the same experience asked for again
is ignored, and every play re-reads progress from the server first, so nothing
finished replays (a preloaded tab tour re-reads it while it shows, and fades
away if it was finished). Events are sent in order in the background; nothing on screen
waits for them. In a setup, Next moves at once (only a step with `branches`
waits for the server) and a burst of presses within 250 ms counts once; in a
tour, only the first step with a target waits for it, later missing targets are
skipped at once, and a newer move cancels an older one. Back works at any time.
`tab-guides.js` no longer plays its own tutorials when this library is present.

## Announcements

"Something new is here, once." Kind `announcement`, trigger `app_loaded`, one step,
no action: an announcement is a definition played by this runtime, not a modal of
its own. `guided-announcement.js` draws a website billboard in a popup with a close
button. Close and the page's own button each finish it (`dismiss`, `complete`), in
the experience's server progress, so a popup's `scope` decides whether that is per
organization or per person; one that introduces a flag is always per person. A step's `options` name `billboard` and what the button
opens: `workflow` and `order_scope` (`fm:new-project-workflow`, which
`ExteriorOrder.prefer` answers for Roof or Full Exterior).

`app_loaded` runs once per page load in the top window, after the first list, and
not while staff act as a customer (`#impersonationBanner`), who would otherwise use
it up. An experience naming a flag as `introduces` is eligible only while that flag
is in the [introduced state](feature-flags.md#introducing-a-flag).

**Previewing.** `FirstMateGuides.preview(id)` (from the console, for example
`FirstMateGuides.preview('exteriors.introduction')`) plays one experience as this
person would see it the first time: `GET .../experiences/:id/preview` resolves it for
any signed-in person in the organization, with no progress and without its
eligibility (capabilities, permissions, conditions) or introduction checked; steps
keep their own eligibility. The player runs with a `track` that sends nothing, so a
preview records no event or progress and the real one still plays on its trigger.
Try It Now still opens the order, which checks access itself: an organization
without Exteriors can preview the popup but cannot order a Full Exterior.

**Billboards** (`guided-experiences/billboards.ts`). The website is another origin,
so a frame of it could not be reached to add a click handler. The app serves its own
copy at `GET /v1/guided-experiences/billboards/:id`: signed-in callers, listed ids
only, read from the website with a 60 second cache, with a `<base>` to the website
and a small script added. The element id is one constant per billboard
(`EXTERIORS_POPUP_TRY_BUTTON_ID`); the page may otherwise change freely. That copy
runs in a sandbox with an opaque origin (`Content-Security-Policy: sandbox`, and on
the frame), so whatever a page does, it has no cookies, storage or app access, and
the script's only way out is `postMessage`, which the runtime accepts only from that
frame's window. A consequence for the page: a font on the website needs
`Access-Control-Allow-Origin`, or the fallback font shows; images and stylesheets do
not.

Nothing shows, and nothing is used up, until the page has loaded and said so: an
unpublished billboard (404, on production) or one that does not answer in 8 seconds
leaves the announcement to play on a later load. On the development data environment
an unpublished page is replaced by a stand-in with the right button. If the page has
no element with the id, it still shows, with the platform's own Try It Now under it
and a console warning, so a renamed button cannot strand anyone.

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

## Checklists: setup and tour

Library entries `guided_experience/checklists.setup`, `checklists.punchlist_tutorial`, `checklists.tab_tutorial` and `guided_tab_faqs/project.checklists`:

- `checklists.setup` (modal, organization, replayable): the first time someone who manages projects opens a
  project's Checklists tab. It `requires` `company.type`, so an organization that has not said what kind of company
  it is answers that first. Until it has run, a project gets no checklists at all where the organization has
  Checklists (`checklists.initializeFromScope.v1` skips with `checklists_setup_pending`): nobody has chosen them yet
  (FM-600). Its steps are one module (`guided-experiences/checklists-setup.js`) in three modes. `use_cases` picks
  the checklists to start with: crew safety (signature required), work completion and, last, a customer punch list
  (the customer ticks items off in their portal), which starts unpicked (`selected: false`) and empty. What each
  says is the step's options; the `roofing` variant (chosen when `organization.industry_sets` contains `roofing_exteriors`)
  has roofing items. Then one `edit_<use case>` page per picked checklist (branches on
  `selections.checklist_use_cases`), titled "Here's your … checklist": the default checklist as it will be, to change
  by typing or by dictating, with how to dictate on the first one. Dictating asks `/checklists/voice` in mode
  `draft` what to add and writes nothing. Last, `review` shows the defaults side by side and says every new project
  starts with them. Completion: `checklists.setup.apply` (`workforce/checklists-setup.ts`) saves them as the
  organization's default checklists and adds them to that project once each (source key `setup:<use case>`, which
  the Checklists app marks with a quiet Default tag, `data-fmcl-default`), then plays the punch list tour and the
  tour. Playing it again changes only its own picks. **Checklist settings** (the gear on the Checklists tab,
  `checklistView=settings`, GP-1) edit the same defaults afterwards: per pipeline (scope template), the stages each
  default is added in (`"all"` or stage ids), making one of the project's checklists a default, or removing one
  (`workforce/checklist-defaults.ts`; provider `checklist-defaults.settings`, action `checklists.defaults.save`). A
  pipeline nobody set up adds every default when a scope starts, as before; a set-up one adds its all-stages lists
  and the starting stage's at scope start and each stage's when the project reaches it
  (`checklists.addStageDefaults.v1`, default organization rules `platform_checklists_stage_defaults` on
  `work.node.started` and `platform_checklists_stage_defaults_manual` on `work.plan.stage_manually_set`). Lists are
  added once per project, a deleted one is not added again, and nothing is taken off when a project moves on.
- `checklists.punchlist_tutorial` (overlay, person, replayable, needs `platform.customer_portal`): no `tab`, so it
  carries on across tab changes. It points at a checklist shared with the customer
  (`[data-fmcl-customer-shared=true]`), has them press the Customer Portal tab, shows the link card, and has them
  press Checklists to come back. Every step's target needs that shared list (or the portal tab it opened), so
  where the punch list was not picked it shows nothing and the Checklists tour follows.
- `checklists.tab_tutorial` (overlay, person, replayable): that new projects start with the default checklists and
  how the tag marks them, the lists, who completes them and the signature option,
  adding an item, comments, changing a list by voice, the document button and Send to crew app (each only where its
  capability is on), and last a step that waits for the person to press New from Audio and ramble about a checklist
  (or skip). It plays after the setup, or on the tab once the organization has finished it.

## Materials: the first use

Library entries `guided_experience/materials.*` and `operations.*`, with the tab questions in `guided_tab_faqs/*`:

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
  away for someone not asked to set it up: `person.eligible`). Operations is visible on every project, including before measurements and on
  drafts; the tutorial never gates tab visibility.
- FAQs for Materials, Photos, Docs, Reports, Customer Portal and Overview.

**Price book setup** (`pricebook/setups/roofing.ts`). Products, rules, regions and
the kinds of roof (`roof_types`, each naming its component systems) come from
the config library entry `pricebook_setup/roofing.catalog` (the research catalog,
read in its own schema); the setup's default tables (featured brands, brand looks,
default slots, ice coverage choices, categories) are `pricebook_setup/roofing.settings`.
All of it is edited on dev as [config library](config-library.md) data, not in
code. Every manufacturer in the catalog is offered,
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
  lead boot first (`default_slots`, `slotDefault`);
- how far ice and water runs (`ice_coverage`): 18 in at eaves and rakes plus
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
(`pricebook_setup/roofing.components`, `status:
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
`pricebook_setup/roofing.suppliers` (which manufacturers each
stocks, `full_range` or `retail_core`, a brand colour, observed prices from
`material_library/roofing`)
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


## Tab tours: Photos, Docs, Reports, Customer Portal

One overlay tour per tab, each its own `guided_experience` entry:
`photos.tab_tutorial` (`project.photos`, `platform.project_photos`),
`docs.tab_tutorial` (`project.docs`, `platform.documents`),
`reports.tab_tutorial` (`project.measurements`, `apps.firstmeasure`) and
`customer_portal.tab_tutorial` (`project.customer_portal`,
`platform.customer_portal`). **The Reports tour is off for now** (Jack, Nov 2):
its entry and its replay question were removed from the library, so it is in no
snapshot; revert `reports.tab_tutorial` to revision 1 and
`guided_tab_faqs/project.measurements` to revision 1 on dev, export, and un-skip
its browser tests to bring it back. Each is per person and replayable, plays on the
first `tab_opened` of its tab wherever the tab's capability is on, and has an
intro, its steps on the tab's own hooks (a step whose control is not on the
page, such as a report's model before it is ready, is skipped) and an outro
pointing at "Show me the tutorial again". That replay question is one of the
tab's questions in its `guided_tab_faqs` entry (at most eight). A step on a feature the organization can
switch off names its capability in its `eligibility`, so it is never sent where
the feature is off rather than relying on the control being missing: Reports'
Summary (`firstmeasure.measurement_report_summary`) and Support
(`firstmeasure.report_followup`), the portal's customer options
(`scheduling.customer_rescheduling|customer_portal.guest_links`) and the photos
the customer sees (`platform.customer_portal_media`). Photos (revision 2) is
basic: upload or take photos, open one, and the cover photo (set from the viewer's "Set as cover photo"; its tile
shows a Cover pill, `[data-project-cover-current]`). Docs: measurement reports land in the tab, the Shown filter,
Upload, and New, whose dialog starts proposals, contracts, change orders, invoices and work orders. The tour points
at New and names those types rather than stepping inside the New dialog: the documents modal
(`.fmdx-modal-back`, z-index 2147483530) sits above the tour's scrim and card (2147483300/2147483400), so a step
there would be hidden behind it. `tests/guided-tab-tours.test.ts` checks the data and
that every target's hooks are in the tab's source;
`tests/guided-tab-tours-browser.test.ts` plays each tour against the real
service.

## Project window tours: the details tray, then the window

Two short per-person overlay tours, phone only (`covering: true`), both config library
entries with their copy, no tab: `project.details_tutorial` plays the first time the
details tray opens as a sheet (`panel_opened`, a new project opens it): the customer,
the address, measurements, and last the tray's close arrows, which the person presses
(`advance: click`). Their first close of the sheet plays `project.window_tutorial`
(`panel_closed`): the title and its arrows reopen the tray, the tabs along the top, and the
buttons along the bottom (notes, to-dos, activity, the agent), named together rather than
one by one. A skipped tray tour leaves the window tour waiting for that first close. The
tab's own tour (Photos on a new project) waits under the tray and plays after them. On a
phone a tour card sits along the top when its target is in the lower half of the screen,
so it never covers the bottom buttons it points at.

## Schedule: the delivery tour

`project_schedule.delivery_tutorial` (overlay, person, replayable, phone only) shows how a
delivery is scheduled from the project Schedule tab: deliveries sit under their job in the
strip above the calendar, a job or delivery is dragged down onto a day (the job, while it is
not on the calendar, brings its deliveries), or tapped and then a day held. Its trigger is
`manual`: no data trigger knows that a delivery is on screen, so the Schedule panel
(`project-schedule/panel.js`, `offerScheduleDeliveryTour`) asks `FirstMateGuides.play` once
per page, on a touch screen under 720px, when the strip shows a delivery under a job. The
runtime keeps who has seen it. Its targets are the strip's `r-schedule-waiting-family` and
`data-schedule-waiting-kind` hooks; `tests/scheduling-ui-contract.test.mjs` checks the panel
still draws each one.

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

1. Write the experience as a `guided_experience` library entry on dev (the dev
   console's library editor, or `PUT /v1/config-library/entries/guided_experience/<id>`
   with an access key); it plays on the next read everywhere on dev and reaches
   production with the next snapshot. No code, no rollout. Tab questions are a
   `guided_tab_faqs` entry, setup steps a `setup_step` entry.
2. Copy: new `gx_…` keys for every text.
3. Overlay targets: stable attributes (`data-…`), never generated classes. A step
   whose target is missing is skipped, so a tour survives a hidden button; a step
   about a feature that can be switched off also names its capability in the
   step's `eligibility`.
4. Setups: a widget per step; data from a guided source (`sources.ts`, code, the
   one part of a setup that is not data); what is written is a published action
   named in `completion.action`.
5. Pick eligibility (capabilities and permissions, not configurations) and
   triggers; add a variant for anything that should differ by context.
6. Tests: `tests/guided-experiences.test.ts` (engine),
   `tests/pricebook-roofing-setup.test.ts` (the roofing setup) and
   `tests/guided-experiences-browser.test.mjs` (overlay, setup, hand-off, FAQs,
   replay, phone width) and `tests/guided-experiences-flow-browser.test.mjs`
   (portal plus project frame: one experience at a time, fast Next and Back,
   close mid-tour, reopen, reload, switch projects, the tray's lines once, dev
   editing) and `tests/guided-setup-back-gesture-browser.test.mjs` (the phone's
   back control through a setup) and `tests/guided-experiences-dev.test.ts` (dev gating, copy in the
   library, history, revert, reset), and `tests/config-library-guided-kinds.test.ts`
   (the kinds' checks). Set `GX_SHOTS=<dir>` to save screenshots.

## Development: reset, replay and editing copy

Development data environment only (`env.dataEnvironment === "development"`, never
production): `guided-experiences/dev.ts`. Who: a platform administrator (an active
internal admin, as session replay decides) or the development tools audience (a
settings manager in a sandbox test organization, as the [dev console](dev-console.md)). Every
route refuses elsewhere with 404, whoever asks.

- **Reset** (`POST …/organizations/:org/dev/reset { experience_id, scope: me |
  organization }`): clears progress (which also brings back a reveal), the
  exposure that counted it, and its scripted lines in conversations (`line_key`
  prefix), so it plays as new. The price book a setup wrote stays. **Replay**
  plays a tour again; **Restart** resets a setup for me and plays it from step 1.
- **Copy** (`PUT /dev/copy`, `GET /dev/copy/history?key=`, `POST /dev/copy/revert`):
  every piece of copy rendered through `copyHtml` carries its language key; for a
  development editor it is plain-text `contenteditable` and saves 700 ms after
  typing (or on leaving the field). A save is a new [config library](config-library.md)
  revision of every entry that holds the copy's `gx_` key (the experience, a tab's
  questions, a setup step; the experience, step and field where it was edited go in
  the revision's note): the `{ key, text }` with that key gets the new text, for
  everyone on their next load. A string the guided browser libraries draw themselves
  (`L('gx_ui_back', 'Back')`) is a `guided_copy` entry keyed by it, sent as
  `copy_overrides`. History is that entry's revisions where the key's text changed,
  with author and time; revert saves an earlier revision's text as a new revision,
  and revision 0 is the first text the library had (for a library string, its
  built-in text). Markup is refused, everything is shown as text. Scripted agent
  lines are editable in the assistant too (their message carries `copy_key`); lines
  already stored in a conversation keep the text they were written with. Copy
  overrides saved before copy was library data are moved into it once, at startup
  on dev (`importLegacyCopyOverrides`).
- **Languages:** the library holds English. In English it is shown over a catalog
  entry for the key, when there is one; other languages keep their translation.
  Production reads the library snapshot, so an edit reaches it with the next
  snapshot in a release; there is no export to code.
- **Seeing it:** the tools are the Guided experiences section of the
  [dev console](dev-console.md), drawn by `FirstMateGuides.devPanel`: "Editing copy"
  (off until the editor turns it on, remembered per browser; then editable copy has a
  dashed outline), the last field's history and each experience's Replay or Restart,
  Reset me and Reset org. They act on the open project frame. Everything is
  `data-fmr-ignore`.

## Operations setup

`operations.setup` plays in the shared guide runtime over Operations. It offers a
proposal or a quick scope of work; both use `FMDocWorkflow`, native document
templates and retained instances. Both select roofing, gutters and/or siding,
capture measurements and review scope lines. The quick path hides the document
preview and has no payment or signing step. The proposal keeps its ordinary
preview, payment terms and customer lifecycle. Completion publishes an explicit
internal planning scope; it does not claim customer acceptance. The hub requires
that retained artifact before allowing materials generation.

**The proposal tutorial** (`documents.proposal_tutorial`: overlay, per person, replayable,
`platform.documents`) is one tour over any proposal's document workflow: the step list, the work
picker, the live preview and Next, by the workflow's own hooks (`[data-fmdw-root] …`). The
proposal path (in `operations.setup` and in the hub's `operations.proposal.setup`) plays it as a
sub-guide over its workflow (`runGuide`, the scope path plays `operations.workflow_tutorial`); the
Docs tab plays it with its `workflow_opened` trigger (`document_type: proposal`) the first time a
proposal workflow opens. Progress is the person's, on the server, so finishing it in one place
finishes it in the other. The Operations save carries on when something else saved the same
document first (its Send or Present editor, the document reopened after a reload): it reads the
latest revision and saves over it once, and the preview never waits on a save succeeding.

The hub offers optional supplier, equipment, workforce and proposal setup with
estimates of 5, 3, 5 and 10 minutes. Each writer is a published action run as the
person. Labor defaults to `shown: when_configured`, which waits for assignees,
pay sheets or existing labor lists even when the workforce app is off; explicit
existing configuration is preserved. Equipment remains offered until activation.
Optional setup returns to the hub; skipping it does not mark it complete.
The hub derives supplier and fleet completion from their domain readers; the
current collection reads are recorded in the [optimization backlog](../optimization-backlog.md#operations-setup-checklist-lists-suppliers-and-equipment).

The Operations tab treats a kind of resource that is not set up as not a list yet (FM-619): for someone who may run
the setups, it is a tab in the header, coloured like a minimized column's, with a Setup tag on its corner, and the
tab opens its setup. Labor is set up once its column shows (`shown: when_configured` above) and opens
`operations.workforce.setup` (after `operations.workforce.setup.start`, as the card does); equipment is set up once
`operations.setup.status` says the fleet has a unit, and until then has no column and no lists in the work order
unless this project already has equipment on its lists. It opens `operations.equipment.setup`, the hub's ready step
with `options.card: equipment`, which opens that one card at once (the equipment setup, below) and finishes when it is
left. Materials are what the setup itself builds and never get a Setup tag.

This Labor visibility check shares the existing full material-list scan recorded
in the [optimization backlog](../optimization-backlog.md#the-labor-column-reads-every-material-list-when-nobody-does-labor).

## Communications setup

`comms.setup` (modal, organization, replayable; library entry with its copy) plays the first time someone who manages
company settings opens a project's Comms tab (`project.comms`) or the Communications page (`portal.chat`, whose variant
starts with texts and calls). One step, widget `comms-setup` (`guided-experiences/comms-setup.js`, its own pages and
buttons like Operations): what Communications does (texts, calls, email), where to start, then a simple page per
channel. **Texts and calls** runs `comms.setup.start { channel: phone }`: Texts (`comms.sms`) and SMS settings
(`apps.messaging`, `platform.sms_settings`) on; carrier registration and the number stay the 10DLC workflow in Phone
Settings ("Register my business" finishes the setup and opens it). Turning texts on and registration are `texting-setup.js`, shared with the appointment setup. On development the shared test line stands in, as
Phone Settings' "Skip to fully onboarded". Then the **texting plan**: platform billing's `comms.sms` prices, bought with
`FirstMatePlatformBilling.review` (the card on file, else Stripe Checkout); no page where platform billing is off or
nothing is for sale. **Email** runs `comms.setup.start { channel: email }`: the Email inbox (`comms.email`) on and the
company's FirstMate Mail address created (`ensureOrgEmailInbox`), shown on the page. After either, the other one or
"Go to Communications", which completes (`comms.setup.complete`) and plays `comms.tab_tutorial` (Texts, Email and Calls,
each step only where its channel is on). The actions are in `comms/setup.ts`; a channel turned on dispatches
`fm:comms:setup-changed` so the Comms tab shows its tab at once. The project Overview offers a "Set up" card for each
channel that is off, and the call center's "Browser calling is off" notice a button, both replaying the setup on that
channel's page. Tests: `tests/comms-setup.test.ts`, `tests/comms-setup-browser.test.mjs`.

## Appointment setup

`appointments.setup` (modal, organization, replayable; library entry with its copy, FM-515) plays the first time
someone who manages company settings opens the Scheduling tab (`tab_opened` `portal.scheduling`, `skip: "later"`,
FM-553); finished there, the Scheduling tour `scheduling.tab_tutorial` follows (`then: play`, `held: false`) and
points at New Appointment. Skipped there, it is only put off ("Skipping for later" above): it plays again the first
time they book an appointment, through its `before_action` on `[data-new-appointment]` (Scheduling's Appointment and
+ buttons, the project Schedule panel), unless they skipped it in the same session within the hour. On that click
the click is held, the setup plays and then the New appointment dialog opens (`then: resume`) with the types it
made, with no tour over it. Its `intro` tells them why it asks (how they manage their calendar). It `requires` the
[setup steps](setup-steps.md) `company.type`, `company.services` ("the kinds of projects we do"),
`company.sales_team`, `company.workforce` and `appointments.kinds`, each asked only while unanswered, so a company
that answered them in another setup goes straight to its own step. That one step, widget `appointments-setup`
(`guided-experiences/appointments-setup.js`, its own pages like the Communications setup), asks for each kind chosen:
text the customer before it starts, text them when we're on the way, and who goes (me, our sales team, a crew, a
subcontractor, whoever is free; the teams offered and the default come from who sells and who does the work). When a
text was asked for and texting is not set up (`comms.setup.status`; not offered where Communications is off), it
offers to set it up or skip: **the same flow as the Communications setup**, `guided-experiences/texting-setup.js`
(`setUpTexting`: texts and calls on with `comms.setup.start`, then carrier registration over the page). Both setups
call it; do not copy it. The finish runs `appointments.setup.apply` with `appointment_types`: each type's
`customer_texts` (`{ reminder, on_my_way }` on the appointment configuration) and staffing requirements (me: that
person; sales team: one person of the Sales department where there is one; a crew: one group with all its members;
a subcontractor: none, chosen when booked; whoever is free: one person), and the group and company types the answers
name (`sales_team`, `crew`, `subcontractor`, through `saveAssigneeType`; groups and their members are added in
People). A type with `on_my_way: false` drops the text from the visit's "On my way" step (`workforce/crew_api.ts`);
`reminder` is recorded on the type but no reminder is sent yet. Tests: `tests/appointment-setup.test.ts`,
`tests/appointment-setup-browser.test.mjs`.

## Equipment setup

`equipment.setup` (GP-15, a modal, organization scope) sets up the fleet by asking about the company rather than
showing the Equipment tab: Operations' Equipment card plays it (after starting the Equipment app when it was only
offered), so does the Operations tab's Equipment Setup tag (`operations.equipment.setup`), and so does the first view
of the Equipment tab (`tab_opened` `portal.equipment` with `skip: "later"`), whose tour (`equipment.tab_tutorial`)
follows it there (`then: play, held: false`; entries are read by id, so the setup arms before the tour). Who sees it:
`apps.equipment` and `equipment.manage|manage_company_settings`. It requires `company.type` and `company.locations`
([setup steps](setup-steps.md)), each asked only while unanswered.

Its one step (widget `equipment-setup`, `guided-experiences/equipment-setup.js`) keeps its own pages, and Back and the
phone's back walk them:

1. **Where do you keep your equipment?** One facility (the Equipment app's yard) per location the company said it
   works out of, named here; the facilities the fleet already has come back as they are, and one can be added. The
   address is added later in Equipment › Facilities (it is a Google address there).
2. **What equipment do you use?** The kinds in the step's `options.equipment`, grouped by `options.groups` and offered
   by the company's industry (`industries`, or `company_types`; none means everyone; a company that has not said what
   it is sees them all): pickup trucks, dump trucks and dump trailers, trailers, its own or rented dumpsters, porta
   potties, lifts, and the person's own by name. Each kind names its category (a built-in category's seed key), icon,
   functions (`provides`: debris disposal in cubic yards, per load or not), and whether it is rented (`ownership`,
   `units: false`: a rental company drops one off, nothing to count). The list is library data, not code.
3. **How many do you have?** A count per kind per location.
4. **We've set up your equipment.** Pressing Set up runs `equipment.setup.apply` (a key of its own each time); this page
   follows only once it succeeded, says "You can adjust your equipment at any time in the Equipment tab" and lists what
   the fleet now has. Done finishes the setup (no completion action).

`equipment/setup.ts` holds the action and the `equipment-setup` provider (`status`: facilities, the kinds the setup
made with their units per facility, totals, when it was finished). The action writes through the Equipment app's own
writers and only adds: a facility given back keeps its id (renamed if its name changed), a kind made before
(`seed_key` `setup.<key>`) is reused, and each facility gets only the units it is short of, named `<kind> <n>` with the
facility as their home. What was set up is kept in the default branch's `equipment_setup` module. Run
`tests/equipment-setup.test.ts` and `tests/equipment-setup-browser.test.mjs` for changes here.

Operations settings (the gear on the Operations tab, `materials/settings.js`, Materials settings before GP-15) has the
Equipment tab itself as a sub-tab while the app is on, mounted with `params.routed: false` so it never writes the
page's route.

## Document setup

`documents.setup` (modal, organization, replayable; library entry with its copy, FM-582) plays the first time someone
who manages company settings presses New document: the Docs tab's New (`[data-gallery-toolbar-action="new_document"]`)
or the documents app's (`[data-fmdx-new]`, `[data-fmdx-empty-new]`), through its `before_action`; when it finishes, the
held click opens the New document dialog (`then: resume`). Its intro says documents of all sorts are made here. Every
step is the module `guided-experiences/documents-setup.js` with its own `part`:

- `kind`: a proposal, an invoice, a change order or a completion certificate (`document_kind`). The proposal is the
  large, recommended choice and is already picked (Jack: most people start there); the others sit in a smaller row
  below. A proposal goes on to its questions; another kind goes straight to `style` (a branch on
  `selections.document_kind`).
- `presentation` requires the [setup steps](setup-steps.md) `company.type`, `company.services` and
  `company.sales_team` (who sells, the question the appointment setup asks too), each asked only while unanswered.
  Then: several options to choose from (good, better, best) or one main option (`presentation`); whether the customer
  can mix and match line items, or must pick one of the options given, or (one option) talks to us for a new estimate
  (`customer_changes`); every line item or a broad estimate (`detail`); a written scope of work with photos or just the
  proposal (`scope_write_up`).
- `prices` (optional, "Skip for now": the step's `skip_label`): the lines a proposal is made of. Every instant roofing
  proposal takes its lines from the price book assembly `roof_replacement` (`scope_pieces`), so the lines are its
  components, plus the main roofing items it lacks, off (`document-setup.price_sheet`: `items` with `on`, the rest of
  the price book as `catalog`, the `measurements`). The step widens the sheet and shows them in two columns, each with
  a picture (chosen from its name, else its category), its price per unit, its quantity formula in words and a switch
  (FM-610). It opens on two choices: review the prices by hand, or upload an estimate the company already sends, which
  `documents.setup.read_estimate` reads (a vision pass; writes nothing) into the same lines: matched items take the
  estimate's price and are on, lines the price book lacks are added new, and the rest are turned off. The upload stays
  a button above the list. "Add a line item" takes a name and offers the price book's items; one picked is added, else
  the row expands to a new line: what it is sold in (square, foot, each), its price and how much goes on each job, a sum
  of measurements (each with a factor) or a fixed number. Changed prices go to `prices` (`pricebook.prices.update`);
  `lines` (`on`, in order, and `new_items`) goes only when the lines changed: the finish makes the new items (with
  their formula, merged by name with an item already there) and sets the assembly's components to the lines left on,
  keeping how a kept line is offered (a shingle choice, an optional upgrade) and picking a choice's first when its
  picked one was turned off. Without the assembly the step shows prices only.
- `style`: the three themes (`thm_clean`, `thm_margin`, `thm_triangles`), each previewed with what the answers make:
  `document-setup.previews` resolves the planned template, unsaved, with a sample customer, roof and account
  (`resolveDocumentInstance` with `definition`), and the module renders it with `FMDocRenderer` (`theme_id`). The step
  widens the sheet (`gxs-wide`) and fills it with a looping carousel (Jack): the style in the middle is large and is
  the one chosen, its pages scroll vertically (the wheel passes on to the step at either end) with a grey gutter
  between pages; the others peek in smaller beside it, and a click on one, the arrows, the arrow keys or a sideways
  drag (mouse or finger; the cards follow it, and a short drag springs back) bring it to the middle. A card going
  round the back comes in from beyond its new side while a copy leaves past its old one (FM-608). The expand button
  (or a double click) shows the middle style full screen, with arrows to the others; Escape and a phone's back close
  that first (the step's `escape()`). The step marks itself `data-float-foot`: the player floats Back and Done over
  its bottom edge with no bar or divider and leaves them out of the sheet's height, and the step keeps that corner
  clear (the style's name and dots sit between them; on a phone, above them). A question with two answers shows them
  as two tall, near-square tiles. Tests: `tests/documents-setup-carousel-browser.test.mjs`.
- `copy` (FM-614): the template's wording beside it. The style chosen slides to the right (the step leaving keeps a
  copy of its document and the next glides it into place), and on the left are the template's own words, top to bottom
  (`document-setup.copy`): every text node of fixed words on its pages, a heading or a sentence or more (`copyFields`
  in `documents/setup.ts`); its first heading is the title. Typing changes the document at once (the step lays the same
  rewrite the finish saves, `applyCopy`, over its preview) and the field with focus marks its text there. Changes are
  the selection `copy` (`{ node id: text }`, a blank line starts a paragraph in the same style). **Advanced** (beside
  the title) saves the template now and opens it in Doc Studio's template editor over the sheet (`documents.studio`
  with `params.embed = { templateId, onClose }`); its "Back to setup" publishes what was changed and comes back, the
  wording is read again from that template and `keep_edits` is set, so the finish starts from it, not the library's.
- `first` (FM-614): the first proposal from the new template, for a proposal set up inside a project. The template is
  saved (`documents.setup.apply`), a draft is made from it for the project's customer and its own workflow runs in the
  sheet: the Docs app (`project.documents`, embed `startFromTemplate`, with `history: false`, `focus: false` and
  `workflowOptions`) with its top bar hidden, the wording's document gliding into the workflow's preview. It is how every
  proposal starts from now on. The step is its own navigation (a module step may return `handlesNavigation`, `back`
  and `backDepth`, like the Operations workflow): Previous on the workflow's first step goes back to the wording, a
  phone's back walks its steps, and Send's Done finishes the setup with `resume: false`, so New document does not open
  over the proposal. Going back and on again reopens the same draft (`first_document_id`). Anywhere else (another kind,
  no project, the setup Operations' Proposals card starts) the step finishes the setup at once. Operations' own
  `operations-document` step builds Operations' fixed proposal through the `operations.*` actions and is not this one.

A payment widget (`doc.payment_schedule`, `doc.pay_now`) in an organization with payments off (`documents.payments`,
marked `disabled` in the resolved definition or off in the renderer's `capabilities`) still draws what is owed: the
schedule and the amount due, with no Pay button, no QR to pay online and no notice that payments are off, in the
editor, the portal, these previews and the PDF (FM-608). An e-signature that is off keeps its disabled box. Tests:
`tests/doc-payments-off-browser.test.mjs`.

The finish, `documents.setup.apply` (`documents/setup.ts`), picks the library template the answers describe
(`planDocument`: options → Good / Better / Best; one option, itemized → the itemized proposal with line prices; a
broad estimate with a written scope → the itemized proposal without line prices; a broad estimate alone → the one-page
proposal; another kind → its current default), and publishes the organization's own copy, `tpl_setup_<kind>` (with
its workflow `wfl_setup_<kind>`: no Photos & description step without a written scope, no customer's choosing step
when the customer cannot change it, previews retargeted), in the chosen theme, with its page regions refitted to that
theme's margins (`FMDocModel.pageSetupOverrides`, as choosing a style in the editor does; the library proposals are
laid out for the Margin rail). It is the kind's `default_for_type`
(the mark leaves every other template of the kind), replaces the kind's first pin in New document, and is never a
library copy (no `preset`, `library`), so the library neither upgrades nor retires it. Running it again republishes
the same template; with nothing changed since (the first proposal saved it a moment before) it adds no version and
writes no prices again. `copy` is laid over the template's wording, and `keep_edits` starts from the template as it was
published in the template editor (when made from the same library template), with the style chosen applied over it.
The answers are kept in the default branch's `document_setup` module (`document-setup.status`).
Tests: `tests/document-setup.test.ts` (library entry in `tests/fixtures/document-setup-library.json`).

## Limits (prototype)

- The scripted turns are stored in English; the person sees their own language.
- Branch conditions are evaluated on the server when a step is done; there is no
  client-side preview of a branch.
- `tab-guides.js` still plays its own minimal tutorials; moving them onto this
  runtime is the next step (docs/architecture/project-tab-guides.md lists them).
- Regional multipliers and many prices are estimates (see the research README).
- With nobody to do labor yet, the Labor column's rule reads every material list
  ([optimization backlog](../optimization-backlog.md#the-labor-column-reads-every-material-list-when-nobody-does-labor)).
