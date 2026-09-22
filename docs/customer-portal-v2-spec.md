# Customer Portal v2 — Architecture & Implementation Contracts

Scope: everything on the portal roadmap — server-driven tabs, scope-targeted
pages, the `portal.*` widget pack, customer-authored content (uploads,
comments, upsells, punch lists, signoff), portal messaging + live chat, guest
sharing, recurring work, and the portal-customizing agent.

Grounding docs: `docs/web-builder-spec.md` (§6 portal injection, §9 non-goals
that this spec cashes in), `docs/document-engine-contracts.md` (§2 widget
contract, §10 `web.*`), `docs/live-chat-spec.md` (§8 portal integration),
`docs/comms-spec.md`.

---

## 0. What exists today (verified, not assumed)

| Capability | State | Anchor |
|---|---|---|
| Multi-project portal (one link, N projects) | built | `platform/api.ts:5451` `contact_portal`; `customer_portal.js:321` |
| Document engine integration (render/sign/pay/workflow) | built | `customer_portal.js:604-706` |
| Custom pages as portal tabs | built | `websites/service.ts:940` `listPortalPages` |
| Schedule / Photos / Proposals / Payments / Checklists tabs | built | `customer_portal.js:902` `tabs()` |
| Estimate item selection (on- and off-document) | built | `customer_portal.js:1128-1292`; `doc.choice_group` |
| Checklists with customer completion + evidence | built | `workforce/crew_storage.ts:345` `normalizeChecklistCustomerAccess` |
| Recurrence engine (`calendar_event`, payments) | built | `platform/recurrence.ts:242` |
| SMS/email/webchat comms (staff side) | built | `comms/api.ts:168`; `comms.sms` capability |
| Live chat service **including portal grants** | built | `chat/service.ts:398` `mintPortalGrant` — **never called** |
| Shared server widget-resolver registry with a `project` slot | built | `documents/widgets/registry.ts` `WidgetResolveContext.project` — **portal path passes `null`** |

The two "built but unwired" rows are the reason this plan is cheaper than it
looks. `mintPortalGrant` is exported and the chat session endpoint already
verifies grants; nothing mints one. `WidgetResolveContext` already carries a
`project` field; `resolveSitePage` hardcodes `project: null` at
`websites/service.ts:788`.

### Not built

Pages by project type · Home-as-widgets · reviews / arrival / activity-feed /
team / portfolio / nearby-jobs / Google-reviews widgets · customizing agent ·
customer-facing scope + upsells · proposalless jobs · customer photo upload ·
customer doc upload · photo comments · punch-list limits + signoff · completion
signature flow · portal messaging surface · guest sharing · social posting.

---

## 1. The four foundations

Thirteen unbuilt items collapse into four primitives. Build these first; every
feature after them is a small additive change rather than a new subsystem.

- **F1 — Server-driven tab descriptors.** The portal decides tabs on the
  server, not in `tabs()`. Unlocks: Home-as-widgets, standardized tabs, tab
  ordering/renaming, scope targeting, per-project tab gating, and the
  customer-docs/messages/punch-list tabs — all as data.
- **F2 — Project-scoped page resolution.** Thread the portal's project +
  customer into `resolveSitePage` and the widget resolve context. Unlocks:
  every data-driven `portal.*` widget, and `{{project.address}}`-style bindings
  in portal pages.
- **F3 — Portal settings + the customer-write primitive.** One authenticated
  customer-action surface with per-portal permissions, resolved org-default →
  project-override. Unlocks: uploads, comments, upsells, punch-list signoff,
  completion signature, guest sharing.
- **F4 — `portal.*` widget namespace + `ctx.portal`.** A widget pack in the
  shared `FMDocWidgets` registry, plus an additive render-context extension
  that gives widgets a write channel. Unlocks the entire widget wishlist.

**Ordering rule:** F1 and F2 are independent and can run in parallel. F3
depends on nothing but should land before any write feature. F4 depends on F2
(for data) and F3 (for writes).

---

## 2. F1 — Server-driven tab descriptors

### 2.1 Payload

`publicCustomerPortalPayload` (`platform/api.ts:5433`) gains a top-level
`tabs` array, computed per active project:

```jsonc
"tabs": [
  { "id": "home",        "kind": "system", "label": "Home",     "icon": "fa-house",
    "order": 10, "source": { "type": "page", "page_id": "page_..." } },
  { "id": "schedule",    "kind": "system", "label": "Schedule", "icon": "fa-calendar-days", "order": 20 },
  { "id": "photos",      "kind": "system", "label": "Photos",   "icon": "fa-images",  "order": 30 },
  { "id": "documents",   "kind": "system", "label": "Documents","icon": "fa-file-lines","order": 50 },
  { "id": "page:roof-care", "kind": "page", "label": "Roof Care", "icon": "fa-house-chimney",
    "order": 55, "page_id": "page_..." }
]
```

Rules:

- The server applies, in order: capability gates → per-project data gates
  (today's implicit rules: Documents only when `resources.documents` is
  non-empty, Checklists only when customer-visible checklists exist) → audience
  targeting (§3) → org tab config → sort by `order`, then label.
- `id` values for built-ins are frozen strings (`summary`/`home`, `schedule`,
  `photos`, `checklists`, `proposals`, `documents`, `payments`). Custom pages
  keep the existing `page:<slug>` prefix — `docs/web-builder-spec.md` §6 makes
  that prefix a contract; do not change it.
- `source` is optional and only present when a system tab is rendered from a
  page rather than built-in markup.

### 2.2 Client

`tabs()` in `customer_portal.js:902` becomes:

```js
function tabs(){
  const served = state.payload?.tabs;
  if (Array.isArray(served) && served.length) return served.map(normalizeTabDescriptor);
  return legacyTabs();  // today's function, renamed — unchanged behavior
}
```

**This fallback is mandatory, not optional.** It keeps every existing portal
rendering identically if the payload predates the change or the tab computation
fails, and it is what lets F1 ship without touching the visual surface. Per the
project's UI rule, no existing tab's markup, ordering, or styling changes in
this phase — only the source of the list.

### 2.3 Org tab config

Lives on the `customer_portal` site record (`websites` collection),
`settings.portal_tabs`:

```jsonc
"portal_tabs": {
  "home":      { "label": "Welcome", "order": 10, "enabled": true },
  "proposals": { "enabled": false },
  "photos":    { "label": "Job Photos", "icon": "fa-camera" }
}
```

Only `label`, `icon`, `order`, `enabled` are overridable. Unknown keys are
ignored. This cashes in the web-builder spec's declared seam ("portal
blessed-tab configuration … seam: `system_pages` descriptors"): the existing
`system_pages` constant becomes the descriptor source, and the Web Editor's
locked system-page tiles become editable rows.

### 2.4 Home as widgets

No new field. The `customer_portal` site record already has `home_page_id`
(unused for the portal today). When it points at a published + enabled page:

- The `home` tab descriptor gets `source: { type: "page", page_id }`.
- The client renders it through the existing `mountCustomPage()` path.
- When unset, the `home` tab keeps id `summary` and renders today's summary
  markup verbatim.

The default seed for a new org sets no `home_page_id` — orgs opt in by
designing a Home page. Existing orgs are untouched.

---

## 3. Pages by project type (audience targeting)

### 3.1 Page record extension

`website_pages` `data` gains an optional `audience` block (additive; absent =
visible to all, which is today's behavior):

```jsonc
"audience": {
  "match": "any",                    // "any" | "all"
  "scope_template_ids": ["tpl_roof_replacement"],
  "tag_ids": ["tag_commercial"],
  "project_status": ["active"],
  "custom_field": { "key": "roof_type", "in": ["shingle","metal"] }
}
```

Empty/omitted arrays are wildcards. `match: "all"` requires every populated
dimension to match; `"any"` requires at least one.

### 3.2 Evaluation

New helper in `platform/api.ts`:

```ts
async function projectAudienceFacts(orgId: string, project: JsonObject): Promise<{
  scope_template_ids: string[];   // from scope plans — scopes/service.ts template_id
  tag_ids: string[];
  status: string;
  custom_fields: JsonObject;
}>
```

`listPortalPages` gains a second parameter:

```ts
export async function listPortalPages(
  orgId: string,
  facts?: ProjectAudienceFacts
): Promise<{ site_key: string; pages: PortalPageRef[] } | null>
```

When `facts` is omitted, pages with **no** audience block behave exactly as
today (no filtering), which keeps the existing call signature valid.

**Implemented as fail-closed:** a page with a *populated* audience block is
hidden when no facts are supplied. A caller that cannot say who is looking does
not get to see targeted pages. (This tightens the original design, which
disabled filtering wholesale on a missing `facts`; that version would have shown
every targeted page to every customer the moment a caller forgot the argument.)

### 3.3 Security invariant

**Audience rules never leave the server.** The client receives only the pages
it is allowed to see. Do not add `audience` to `PortalPageRef`, and do not
filter client-side. A portal page targeted at commercial customers must be
absent from a residential customer's payload, not hidden by CSS.

Corollary: `GET /v1/websites/public/portal/:portalUuid/pages/:pageId` must
re-check audience server-side. Passing the filter in the tab list is not
sufficient — the page-fetch route is directly addressable.

---

## 4. F2 — Project-scoped page resolution

### 4.1 Signature change

`websites/service.ts:771`:

```ts
export async function resolveSitePage(
  orgId: string,
  site: JsonObject,
  page: JsonObject,
  source: "draft" | "published",
  portalContext?: { project: JsonObject; customer: JsonObject; portal: JsonObject }
)
```

When `portalContext` is present:

- `scope` becomes `{ params, org, site, project, customer }` instead of
  hardcoded nulls at `service.ts:788`. Binding expressions like
  `{{project.address}}` and `{{customer.name}}` start resolving in portal
  pages — a meaningful win independent of any new widget.
- `widgetCtx.project` carries the project, and a new `widgetCtx.portal`
  carries `{ portal_uuid, project_id, contact_id, preview }`.

Public-site resolution passes no `portalContext` and is byte-for-byte
unchanged.

### 4.2 Widget resolve context extension

Additive to `documents/widgets/registry.ts`:

```ts
export type WidgetResolveContext = {
  /* …existing… */
  portal?: {
    portal_uuid: string;
    project_id: string;
    contact_id: string;
    preview: boolean;
    settings: PortalSettings;     // resolved, §5.1
  } | null;
};
```

Resolvers that require portal context return `null` when it is absent — the
existing "resolvers that lack data return null" contract already covers this,
so a `portal.*` widget dropped on a public marketing page degrades to its
placeholder rather than erroring.

### 4.3 Caching

Portal page payloads are now per-project and must not be cached by page id
alone. There is no cache on this path today; if one is added later, the key is
`(orgId, pageId, projectId, source)`.

---

## 5. F3 — Portal settings + the customer-write primitive

### 5.1 Settings

The `customer_portals` record's dormant `settings{}` object (declared as a seam
in `web-builder-spec.md` §9) becomes real. Org defaults live at
`customer_portal` site `settings.portal_defaults`; per-project overrides live on
the portal record. Resolution is a shallow per-block merge, project wins.

```jsonc
"settings": {
  "schema_version": 1,
  "uploads": {
    "photos": true, "documents": false,
    "max_files": 25, "max_bytes": 26214400,      // 25 MB per file
    "require_caption": false
  },
  "comments":   { "photos": true, "documents": false },
  "punch_list": { "enabled": true, "customer_can_add": true, "max_items": 10,
                  "require_photo": true, "require_comment": false, "require_signoff": true },
  "upsells":    { "enabled": true, "require_signature": false, "auto_accept_under_cents": 0 },
  "completion": { "signature_required": true, "release_docs_on_signoff": true },
  "messaging":  { "enabled": true, "channel": "auto" },   // auto | chat | thread
  "sharing":    { "enabled": true, "max_guests": 5, "default_expires_days": 30 },
  "social":     { "consent_requested": true }
}
```

A single normalizer, mirroring `normalizeChecklistCustomerAccess`
(`workforce/crew_storage.ts:345`) exactly in shape and defensiveness:

```ts
export function normalizePortalSettings(orgDefaults: unknown, projectOverride: unknown): PortalSettings
```

Default-deny on anything unrecognized. Every block defaults to the least
permissive value that preserves today's behavior (i.e. all writes off).

### 5.2 The write surface

New routes under the existing portal prefix (`platform/api.ts` ~1665, beside
the checklist routes which are the working precedent):

```
POST   /customer-portals/:portalUuid/uploads                 multipart; kind sniffed, not declared
DELETE /customer-portals/:portalUuid/uploads/:mediaId        WITHDRAW (soft) — own uploads only
GET    /customer-portals/:portalUuid/media/:mediaId/comments
POST   /customer-portals/:portalUuid/media/:mediaId/comments
DELETE /customer-portals/:portalUuid/media/:mediaId/comments/:commentId   WITHDRAW (soft)
POST   /customer-portals/:portalUuid/punch-items             { title, description }
POST   /customer-portals/:portalUuid/punch-items/:itemId/signoff
POST   /customer-portals/:portalUuid/upsells/:itemId/accept  { signature? }
POST   /customer-portals/:portalUuid/completion/signoff      { signature, consent }
POST   /customer-portals/:portalUuid/messages                { body }
POST   /customer-portals/:portalUuid/guest-links             { label, expires_at, tabs[] }
DELETE /customer-portals/:portalUuid/guest-links/:linkId
```

Every handler follows the identical five-step shape already used by
`attachCustomerChecklistEvidence` (`platform/api.ts:5633`):

1. Resolve portal by uuid; reject non-`active` status.
2. Resolve settings (§5.1); reject when the relevant flag is off — **403 from
   the resolved setting, never from a client-supplied flag**.
3. Reject in preview mode (staff preview is read-only; the client already has
   `blockPreviewAction`).
4. Enforce quota/size/rate limits before reading the body into memory.
5. Perform the write with actor `"customer_portal"`, emit a `customer.*` work
   event, return the public view.

### 5.3 Limits

| Guard | Value | Why |
|---|---|---|
| Max upload size | 25 MB/file | The checklist route's 128 MB cap is fine for a staff-adjacent flow; it is not acceptable on an open, unauthenticated-by-password surface. |
| Files per portal per day | 50 | Abuse ceiling. |
| Comment length | 2 000 chars | — |
| Writes per portal per minute | 20 | Simple in-process token bucket keyed by portal uuid. |
| Accepted upload MIME | image/*, video/*, application/pdf, common office types | Reject on sniffed type, not the client-declared one. |

### 5.4 Threat model

The portal uuid is a bearer capability in a URL. It can land in browser
history, referrer headers, and forwarded emails. Therefore:

- Customer writes are **additive and reversible** — create media, create
  comments, create punch items, record signatures. No route lets a portal
  visitor delete project data, alter prices, or modify anything the business
  authored.
- **"Delete" is withdraw, never destroy.** The DELETE routes stamp
  `withdrawn_at` on the visitor's own upload/comment: it leaves the customer
  view, the bytes and the audit row survive. A bearer token in a URL must not be
  able to destroy evidence of what the business was sent. Withdrawal also does
  **not** refund daily upload quota, or upload-withdraw-repeat would be an
  unbounded loop.
- Signature-bearing actions (upsell accept, completion signoff) capture the
  same evidence payload the document engine already collects
  (`signatureEvidencePayload` in `customer_portal.js`) — IP, user agent,
  timestamp, typed/drawn method.
- Guest links (§8.3) are strictly read-only and carry a reduced tab set, so
  customer-initiated sharing never widens the write surface.

---

## 6. F4 — The `portal.*` widget pack

### 6.1 Packaging

New library `public/libraries/portal-widgets/firstmate-portal-widgets.js`,
global `FirstMatePortalWidgets`, registering into the same shared
`FMDocWidgets` registry — an exact structural clone of
`web-widgets/firstmate-web-widgets.js` (IIFE + UMD tail, `widgetsLib()` lookup,
self-injected `<style id="fm-portal-widgets-styles">`, `SCRIPT_SRC`-relative
sibling resolution). Load order: doc-widgets → web-widgets → portal-widgets.
Add the script tag to `customer_portal/index.php`, `customer_portal/preview.php`,
and the Web Editor bundle list.

Server resolvers register from a new `public/v1/platform/portal_widgets.ts`
(the data lives in the platform module) via `registerDocumentWidgetResolver`,
imported for side effect before the API boots.

### 6.2 `ctx.portal` — the widget write channel

Additive extension to `docs/document-engine-contracts.md` §2, to be recorded
there as **§11 (portal widgets)**. Present only when the host is the customer
portal:

```js
ctx.portal = {
  portalUuid, projectId, preview,
  settings,                          // resolved PortalSettings (read-only)
  actions: {
    upload(file, { kind, caption }),
    comment(mediaId, body),
    addPunchItem(input),
    signoffPunchItem(itemId, signature),
    acceptUpsell(itemId, signature),
    signCompletion(signature, consent),
    sendMessage(body),
    createGuestLink(input),
  },
  refreshPayload(),                  // re-fetch the portal payload and re-render
};
```

`ctx.submitOutput` stays exactly what it is — a *document output* channel.
Portal widgets must not overload it; conflating the two is how document
snapshots end up with non-document state in them.

### 6.3 Widget catalogue

| id | Category | Server data | Writes |
|---|---|---|---|
| `portal.activity_feed` | data | customer-visible work events (§7) | — |
| `portal.reviews` | data | `feedback` module ratings + configured destinations | — |
| `portal.google_reviews` | data | configured place id, server-cached ≥6 h | — |
| `portal.arrival` | data | `calendar_events` + crew status (§8.1) | — |
| `portal.team` | data | assigned workforce users, customer-safe fields only | — |
| `portal.portfolio` | media | media library before/after pairs | — |
| `portal.nearby_jobs` | data | projects with shared media, coarse geo (§6.4) | — |
| `portal.welcome_video` | media | thin config wrapper over `doc.video` | — |
| `portal.uploads` | input | visitor's own uploads | ✅ |
| `portal.photo_comments` | input | comments on shared media | ✅ |
| `portal.punch_list` | input | checklists of `kind: "punch"` | ✅ |
| `portal.upsells` | commerce | scope catalog / pricebook items | ✅ |
| `portal.completion` | input | signature + finalization docs | ✅ |
| `portal.messages` | input | comms thread (§9) | ✅ |
| `portal.recurring` | data | `recurrence_series` for the project | — |
| `portal.share` | input | guest links | ✅ |

The Web Editor exposes portal-only page templates for Home, Welcome, Team,
Portfolio, Activity and Nearby Projects. Home's project header, next-step,
appointment and recent-photo regions are deletion-locked essentials; all
other content is ordinary editor-authored sections and widgets. `doc.video`
accepts either uploaded video media or an external URL, so Welcome is a page
template rather than a hard-coded portal tab. Nearby Projects includes only
projects explicitly showcase-enabled or selected in the widget, requires
shared project media, and returns neighborhood-precision coordinates rather
than addresses.

Every widget's `renderStatic` must produce a labeled placeholder when `data` is
null, per the existing §2 rule — that is what makes them safe in the editor
canvas and in PDF/static renders.

### 6.4 `portal.nearby_jobs` privacy

This widget shows other customers' projects. Constraints, non-negotiable:

- Only projects with explicitly shared media and an explicit
  `showcase_opt_in` flag are eligible.
- Location is **coarsened to the street or neighborhood** — never a full
  address, never a house number, never a customer name.
- Distance radius is org-configured with a floor of 0.5 mi to prevent
  triangulating a single neighbor.

If any of the three is inconvenient to implement, ship the widget without it
rather than relaxing it.

---

## 7. Customer-visible activity feed

The work-event catalog (`work/events.ts`) has two visibility tiers,
`"activity"` and `"system"`, both internal. Adding a customer tier by widening
that enum is the wrong move — every unregistered event infers its visibility
from its name (`events.ts:20`), so a naming coincidence could leak internal
events to a customer.

**Default-deny with explicit copy.** Extend `WorkEventDefinition` additively:

```ts
export type WorkEventDefinition = {
  name: string;
  description: string;
  visibility: WorkEventVisibility;
  payload?: Record<string, string>;
  /** Presence — and only presence — makes an event customer-visible. */
  customer?: { label: string; icon?: string };
};
```

- The feed resolver reads only events whose definition has a `customer` block.
- The portal renders `customer.label` (a template over an allowlisted subset of
  the payload), never the raw payload object. Interpolating the whole payload
  is how internal user ids and margins reach a customer's screen.
- Unregistered events are never customer-visible, by construction.

This mirrors the `explainer` + `customer_visible` pattern already proven in
`scopes/inventory.ts:38`.

Starter set: `appointment.scheduled`, `crew.arrived`, `work.started`,
`photos.shared`, `document.sent`, `invoice.sent`, `payment.received`,
`punch.item_completed`, `project.completed`.

---

## 8. Feature specs

### 8.1 Technician arrival tracking

No `en_route`/ETA concept exists anywhere in the codebase — this is genuinely
new. Minimum viable, in dependency order:

1. Crew-side status transition on the assignment (`en_route` → `arrived`),
   emitted as work events. Timestamp only.
2. `portal.arrival` renders the day's appointment, the assigned technician
   (name + photo + role, no phone unless org-configured), and the status.
3. **Optional, later:** live position. This needs a location-permission flow in
   the crew app, a retention policy, and an explicit crew-facing disclosure
   that their position is visible to a customer while en route. Do not fold
   this into step 2 — status-only tracking delivers most of the customer value
   with none of the privacy surface.

### 8.2 Punch lists

**A punch list is customer-authored.** It is not a company checklist the
customer can see — the customer writes it, and gates it on both ends:

1. `requested` — the company asks; the customer walks the job and adds items,
   often with photos.
2. `submitted` — the customer signs off *"this is everything that's left"*.
3. `work_complete` — the company does the work and marks the items done.
4. `accepted` — the customer signs off *"yes, these are done"*.

The value is step 2: the customer committing to a **bounded** list, so the
company knows what closing out costs. A company-authored list inverts that and
loses the point.

**Data-driven throughout.** Nothing assumes one list at the end of a project.
Instances come from the `punchlist.request.v1` work automation, bindable at ANY
node in a scope template — so a project can have several, at phase boundaries,
concurrent or sequential. Idempotent per node via `source_key`.

**Terminology is not assumed.** "Punch list" is not universal across trades.
Every customer-visible string resolves through `resolvePunchLabels()`:
instance labels → org defaults → built-in copy, with `{noun}` interpolation so
overriding one word fixes every sentence. The portal *tab label* follows the
same noun.

**Storage.** A `crew_checklists` row carrying a `metadata.punch` block — which
reuses items, attachments, evidence requirements, and the customer item-CRUD
routes the portal already has. The `kind` column is deliberately untouched: it
is clamped to `todo|quality` and other code branches on it.

**Config** (`metadata.punch`, layered org-defaults → instance):
`required`, `customer_can_add`, `customer_can_edit`, `max_items`,
`require_photo`, `require_comment`, `allow_empty`,
`require_submit_signature`, `require_accept_signature`, `terminology_key`,
`labels`.

**Gotcha that bit during implementation:** `readProjectChecklist` returns the
row *without* items. Every punch gate reasons about item state, and evaluating
"is anything outstanding?" against a missing `items` array silently answers
"no" and lets the gate through. Use `readProjectChecklistDetail`.

Signatures use the same payload + evidence shape as document signatures, so a
punch sign-off and a document signature are the same artifact.

### 8.2b Completion sign-off

A document type, not a new subsystem. `documents.issue.v1` already issues from
a template with `deliver: "portal"`, and the portal already renders engine
documents, runs customer-audience workflows, captures signatures, and takes
payment.

- Register `completion_certificate` alongside the other types, with
  `output_schema: { sig_customer: signature required, sig_company: optional }`.
- A `completion.request.v1` scope automation with `mode: document | signature`.
  Document mode issues the certificate; signature mode uses the shared portal
  signature primitive (`platform/portal_signatures.ts`) for orgs that want a
  sign-off without a document. Both write the SAME artifact.
- Where it sits in the scope graph is the gate — see below.

**Gating is data-driven, never a hardcoded server rule.** `conditionMatches`
(`work/engine.ts:53`) evaluates dot-paths over `{ event, payload, context,
project, plan, node }`, and `platform/portal_projection.ts` projects portal
state onto the project document alongside `work_projection` / `lifecycle`. So a
scope author writes, with no engine changes:

```jsonc
conditions: { "project.punch.required_outstanding": "0" }
conditions: { "project.punch.by_key.finish.state": "accepted" }
conditions: { "project.completion.signed": "true" }
```

...or binds an `external_trigger` on `punch_list.accepted` and lets the
dependency graph be the gate. Projection fields are a public contract for every
scope set ever authored — keep them small and stable, like the event catalog.

### 8.3 Guest sharing

New sub-record on the portal document:

```jsonc
"guest_links": [{
  "id": "pgl_...", "uuid": "<32 hex>", "label": "Spouse",
  "created_by": "customer" | "staff", "created_at": "...",
  "tabs": ["home","schedule","photos"],
  "expires_at": "...", "revoked_at": null, "last_viewed_at": "..."
}]
```

`findCustomerPortalByUuid` gains a third match arm: guest uuid → same portal,
`access_mode: "guest"`. In guest mode:

- The tab list is intersected with `guest_links[].tabs`.
- **Every write route returns 403**, checked in the shared step-2 guard (§5.2),
  not per-route.
- Payments, documents, and proposals are excluded from the allowable tab set
  entirely — a guest link must never reach a signing or payment surface.
- Expiry and revocation are checked on every request, not just at issue.

This is the whole point of "safe sharing": the customer forwards a guest link
instead of their own uuid, and revocation is a real control.

### 8.4 Customer-facing scope, upsells, proposalless jobs

Three faces of one idea: the project's scope, rendered for the customer, with
optional add-ons.

- **Customer-facing scope.** `scopes/inventory.ts` already has the
  `explainer` + `customer_visible` pattern for automation entries. Extend the
  same treatment to scope *line items*: an item is customer-visible when it has
  a customer-safe label. Reuse `entryVisible`'s default-deny logic verbatim.
- **Upsells. An accepted upsell IS a change order.** `change_order` already
  exists as a full document type — `scope_items: list<pricebook_line>`,
  `amount_cents`, `payment_schedule`, a required customer signature, and a
  payment output ([documents/types/registry.ts:87]) — and the portal already
  renders, signs, and takes payment on engine documents. Do not build a parallel
  acceptance path; issue a change order and let the existing flow run.

  The "offerable" flag also already exists: pricebook items carry
  `selection: { mode: "optional", selectable_by: ["internal","customer"] }`
  (`pricebook/default_template.ts:124`) — the same mechanism the portal's
  proposal selection groups use. Do NOT add a second flag.

  Flow: `portal.upsells` widget lists offers → customer selects → server
  re-validates ids against the offer catalog and prices from the pricebook
  (never from the client) → `issueDocumentFromAutomation` issues a
  `change_order` with `deliver: "portal"` → existing signature/payment flow →
  existing scope activation adds the work.

  **The flow itself is config, not a product decision.** `upsells.mode`
  (`auto_issue` | `request` | `threshold`) layers org default → scope instance →
  project, like every other portal setting. An `upsells.offer.v1` scope
  automation carries its own config so one org auto-issues small add-ons while
  another routes everything through staff — and a single org can differ per
  scope set.
- **Proposalless jobs.** With a customer-facing scope and an accept action,
  a job needs no proposal document: acceptance of the scope *is* the
  authorization record. Emits `scope.accepted` carrying the same evidence
  payload a signature would.

### 8.5 Estimate item selection (improvement, not new build)

Both selection paths work today. The improvement is consolidation: extract the
selection-group logic from `customer_portal.js:1128-1292` into a shared
component that both the legacy proposal renderer and `doc.choice_group` call.
One codepath, one set of behaviors (mutually-exclusive groups, price deltas,
customer-visible gating), rendered identically in both surfaces.

### 8.6 Recurring work

- **Recurring appointments — surface only.** `recurrence.ts` already
  materializes `calendar_event` series. Add series for the project to the
  portal payload and render "Every 3 months · next visit Sep 14" in the
  Schedule tab plus `portal.recurring`.
- **Recurring projects — new.** `materializeRecurrenceSeries`
  (`recurrence.ts:242`) has branches for `calendar_event`, `payment_schedule`,
  `payment_obligation`, and `payment_payable`. A `project` branch that clones
  from a template project is a self-contained addition following those four as
  a pattern. Treat it as its own work item; it is not a portal change.

### 8.7 Live chat in the portal

The smallest item on the list. `mintPortalGrant` (`chat/service.ts:398`) is
built, exported, and unused; the session endpoint already accepts and verifies
`portal_grant` (`service.ts:433`).

1. In the portal payload builder, when `apps.live_chat` is on and chat settings
   have `portal.enabled`, add
   `"chat": { "widget_key": "...", "portal_grant": mintPortalGrant(...) }`.
2. Load `libraries/chat-embed/firstmate-chat-embed.js` in `index.php` /
   `preview.php` and init programmatically with the grant.
3. Grants expire in 15 minutes (already the case) — the client re-fetches the
   payload to refresh, so long-lived portal tabs need a refresh-on-expiry path.
4. Suppress the widget entirely in preview mode.

### 8.8 Portal messaging (SMS + thread)

Comms already records email/SMS/webchat per project (`comms/api.ts:168`). The
portal needs a customer-facing view of one thread.

- `settings.messaging.channel: "auto"` prefers live chat when the org has it
  enabled and falls back to an async thread otherwise. `"thread"` forces async.
- `POST /customer-portals/:uuid/messages` writes into the project comms feed
  with channel `portal`, so staff see it in the existing Comms tab with no new
  UI.
- Outbound staff replies reach the customer by their preferred channel (SMS or
  email) with a portal deep link — the notification path in
  `comms/notifications.ts` already exists.

### 8.9 Social posting on completion

**This is the one item with a hard external dependency, and it is not a coding
problem.** There is no OAuth/integration substrate in the codebase — the
`connections` module is CRM contact relationships, and the only Facebook
reference is the Meta Conversions API pixel (`platform/api.ts:8501`).

Shipping it requires: a new integrations subsystem (OAuth app registration,
token storage + refresh, per-org connection records), plus Meta App Review for
`pages_manage_posts` / `instagram_content_publish`, which is a multi-week
external review with no engineering lever.

Sequence it last, and build the consent half first — it is independently
useful and unblocked: capture an explicit publish consent at completion signoff
(`settings.social.consent_requested`), gate on feedback rating ≥ threshold, and
queue eligible completion photos into a staff-facing "ready to post" list. That
delivers the workflow with a manual final step, and the OAuth work later
replaces only the last hop.

### 8.10 The customizing agent

A registered agent in the portal/websites domain, following the framework in
`public/v1/agents/` exactly (`definition.ts` + `registerAgent`, per-user tool
permissions), joining the existing five (assistant, chat, comms, scopes, stats).

Tools: `list_portal_tabs`, `read_page`, `create_page`, `save_page_draft`,
`add_widget`, `set_page_audience`, `set_tab_config`, `preview_page`,
`publish_page`.

Guardrails:
- **Drafts only by default.** `publish_page` requires explicit user
  confirmation in the turn; the agent never publishes as a side effect of a
  design request. This matches the draft/publish separation the web builder
  already enforces for humans.
- Audience changes are stated back in plain language before saving ("this page
  will now only appear for roofing projects") — a mis-set audience silently
  hides content from real customers.
- No access to the customer-write routes. The agent designs the portal; it
  never acts as a customer.

---

## 9. Capabilities

```ts
{ key: "portal.customer_uploads",  kind: "feature", parent: "apps.customer_portal",
  label: "Customer uploads", default: false,
  description: "Let portal customers upload their own photos and documents." },
{ key: "portal.customer_comments", kind: "feature", parent: "apps.customer_portal",
  label: "Customer comments", default: false,
  description: "Let portal customers comment on shared photos and documents." },
{ key: "portal.punch_lists",       kind: "feature", parent: "apps.customer_portal",
  label: "Punch lists", default: false,
  description: "Customer-visible punch lists with optional photo evidence and completion signoff." },
{ key: "portal.upsells",           kind: "feature", parent: "apps.customer_portal",
  label: "Portal upsells", default: false,
  description: "Show a customer-facing scope with optional add-on items the customer can accept." },
{ key: "portal.guest_sharing",     kind: "feature", parent: "apps.customer_portal",
  label: "Guest sharing", default: false,
  description: "Let customers create revocable read-only links for family or partners." },
{ key: "portal.messaging",         kind: "feature", parent: "apps.customer_portal",
  label: "Portal messaging", default: false,
  description: "A customer-facing message thread in the portal, recorded on the project comms feed." },
{ key: "portal.social_publishing", kind: "feature", parent: "apps.customer_portal",
  label: "Social publishing", default: false,
  description: "Queue completion photos for social posting after a positive review, with customer consent." }
```

Every new capability defaults **off**. Existing portals must behave identically
the day this ships.

---

## 10. Events

Register in `work/events.ts`, all with a `customer` block where the customer
should see them:

`customer.upload.added` · `customer.comment.added` ·
`customer.punch.item_added` · `customer.punch.signed_off` ·
`customer.upsell.accepted` · `customer.scope.accepted` ·
`customer.completion.signed` · `customer.message.sent` ·
`customer.guest_link.created` · `customer.guest_link.revoked` ·
`portal.tab.viewed` (system) · `crew.en_route` · `crew.arrived`

---

## 10a. Build status (2026-07-28)

Shipped and covered by `tests/customer-portal-v2.test.ts` (19) +
`tests/customer-portal-writes.test.ts` (14):

- **Phase 0** — all four foundations. `platform/portal_settings.ts`,
  `platform/portal_audience.ts`, `platform/portal_widgets.ts`,
  `platform/portal_writes.ts`; `resolveSitePage` portal context;
  `WidgetResolveContext.portal`; `ctx.portal` passthrough in doc-renderer;
  `libraries/portal-widgets/`.
- **Phase 1** — page `audience` (schema + normalizer + patch handling),
  `projectAudienceFacts`, filtered `listPortalPages`, audience re-check on the
  direct page route, `settings.portal_tabs` overrides, Home-from-`home_page_id`.
- **Phase 2** — `portal.activity_feed`, `portal.reviews`, `portal.team`,
  `portal.portfolio`, `portal.welcome_video`, `portal.recurring` (client + server
  resolvers), plus the `customer` descriptor tier on the work-event catalog.
- **Phase 3 (chat half)** — `portalChatHandoff` mints the grant; the embed loads
  inert and starts only on a live portal; grant refresh before expiry.
- **Phase 4 (uploads + comments)** — write routes with the shared five-step
  guard, MIME sniffing, quotas, per-portal rate limiting, soft withdraw.

- **Phase 4 (complete)** — client UI: upload control + withdraw, photo comment
  threads in the lightbox, and the "My Files" tab (server-gated on
  `uploads.documents`).
- **Phase 5 (punch lists, complete)** — `workforce/punch_lists.ts` (states,
  layered config, copy resolution, guards, signature normalizer),
  `punchlist.request.v1` automation, customer submit/accept routes, staff
  complete-work/reopen routes, `resources.punch_lists` payload key, a
  terminology-driven portal tab, and the portal panel with sign-off prompt.
  Covered by `tests/customer-portal-punch.test.ts` (13).

Not yet built — see §11 for sequencing:

- Phase 3's async message thread (comms write-through).
- Completion sign-off (§8.4 sibling): the shared signature primitive and the
  `project.completion.*` events are in place; the request/sign flow is not.
- Customer-facing scope + upsells, selection consolidation, guest sharing,
  arrival tracking, the customizing agent, social consent capture.

## 11. Game plan

Nine phases. Each is independently shippable and leaves the portal working.

| # | Phase | Contents | Depends on |
|---|---|---|---|
| 0 | **Foundations** | F1 tab descriptors (+ legacy fallback), F2 project-scoped resolution, F3 settings + normalizer, F4 library skeleton + `ctx.portal` | — |
| 1 | **Targeting & tabs** | `audience` block, `projectAudienceFacts`, filtered `listPortalPages`, org tab config, Home-as-page | 0 |
| 2 | **Read-only widgets** | activity feed (+ event `customer` blocks), reviews, team, portfolio, welcome video, Google reviews, recurring | 0, 1 |
| 3 | **Live chat + messaging** | mint grant, load embed, message thread, comms write-through | 0 |
| 4 | **Customer writes** | upload routes, comments, customer docs tab, `portal.uploads` / `portal.photo_comments` | 0 |
| 5 | **Punch lists & completion** | `kind: "punch"`, limits, signoff signature, finalization doc release | 0, 4 |
| 6 | **Scope & upsells** | customer-facing scope, upsell accept, proposalless acceptance, selection consolidation (§8.5) | 0, 2 |
| 7 | **Sharing & arrival** | guest links, `portal.share`, crew en-route/arrived status, `portal.arrival` | 0, 1 |
| 8 | **Agent & social** | customizing agent; social consent capture + staff queue (OAuth deferred) | 1, 5 |

Sequencing notes:

- **Phase 3 is disproportionately cheap** — the backend is built. If you want
  an early visible win to validate the foundation work, take it right after
  phase 0 rather than in order.
- **Phase 2 is the highest ratio of user-visible value to risk**: seven
  roadmap items, all read-only, no new security surface.
- **Phase 4 is the first real security surface.** Do not start it before F3's
  normalizer and limits are in place and tested.
- Phases 5–7 can run in parallel across separate branches; they touch disjoint
  files once phase 4 has landed the shared upload plumbing.
- Phase 8's social half is gated on external review — start the consent capture
  early and let the OAuth work trail.

---

## 12. Verification

- `public/v1/tests/customer-portal-v2.test.ts` (new): tab descriptor
  computation incl. capability + data gates; audience matching across all four
  dimensions and both `match` modes; **audience enforcement on the direct
  page-fetch route**; settings resolution (org default → project override);
  every write route's 403 paths (setting off, preview mode, guest mode,
  over-quota); guest-link expiry and revocation; punch `max_items`; upload MIME
  sniffing.
- Extend `websites-api.test.ts`: `resolveSitePage` with and without
  `portalContext`; public-site output unchanged (regression guard).
- Extend `chat` tests: portal grant round-trip through session creation.
- `node --check` on all new/edited frontend libraries.
- Browser pass per phase against the real portal: **most importantly, a
  pre-existing portal with no new settings must render byte-identically after
  each phase.** That is the regression that matters.

---

## 13. Non-goals (recorded so the API does not box them out)

- Portal login/password auth — the uuid remains the capability. Seam:
  `access_mode` on portal resolution already distinguishes guest from owner.
- Customer-initiated scheduling/rescheduling. Seam: `portal.arrival` data path.
- Per-customer page overrides (a page edited for one project). Seam: the same
  `settings{}` object, plus page `audience`.
- Offline/PWA portal. Seam: the payload is already a single JSON fetch.
- Multi-language portal. Seam: `platform-terminology` already indirects labels;
  tab descriptors carry server-rendered labels, so translation lands in one
  place.
