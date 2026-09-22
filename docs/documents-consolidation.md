# Documents Consolidation (2026-08)

One project tab for documents, a deprecated legacy proposals app, and a
data-driven global New button. This doc records what changed, why, and where
the seams are.

## 1. One Docs tab

The project modal previously had three document surfaces: **Docs**
(`apps/docs/project.js`, media refs: uploads / receipts / signed-proposal PDFs /
measurement reports), **Documents** (`apps/documents/project.js`, document-engine
SmartDoc instances), and **Proposals** (legacy builder). They are now one tab:

- **`project.docs` ("Docs") is the surviving surface.** Its gallery lists BOTH
  universes: engine documents (from `DocumentsAPI.documents.listForProject`)
  merged with platform project-document references.
- **`project.documents` no longer surfaces a tab** (`visible:false` in its
  `registerApp`). Instead the Docs tab mounts it hidden via
  `FirstMateEmbeddableApps.mount(host, 'project.documents', { params: { embed:
  { enabled:true, onReady, onDocsChanged, onDocScreen, onListView } } })`.
  In embedded mode the module renders no list; it hands the host an **embed
  API**: `openCreateModal`, `openDocument`, `openPreview`, `getDocs`,
  `refresh`, etc. The doc screen (editor/workflow stepper) still renders into
  its own root — an absolutely-positioned host layer inside the Docs panel
  that the host shows/hides on `onDocScreen`/`onListView`.
- **Open routing:** engine documents open in the SmartDoc editor
  (read-only statuses render view-only there); engine documents with
  `source: "uploaded"` or type `receipt` open in the rendered preview; media
  references (uploads, receipts, measurement/report PDFs) keep the
  markup/media viewer.
- **New button on the tab:** a "+ New" gallery toolbar action opens the
  engine's create wizard (type → template → params / workflow-first).
- **Gating:** the Docs tab shows when EITHER `platform.project_docs` (legacy
  uploads-only) OR `platform.documents` (engine) is on. The manifest's
  single-capability mapping for `project.docs` was removed; the dual-flag gate
  lives in the app's own `enabled` predicate. The embedded engine mount is
  denied cleanly when `platform.documents` is off (tab degrades to legacy
  uploads-only behavior).
- Old deep links `projectTab=documents` / `projectTab=proposal` alias to
  `docs` in `setActivePreviewTab`.

## 2. Proposals deprecated

The legacy proposals app is **deprecated, hidden, not deleted**:

- `apps/proposals/project.js` (project tab) and `apps/proposals/global.js`
  (portal tab) register with `visible:false` and carry DEPRECATED file-header
  banners. Flip `visible` locally if a historical record needs debugging.
- The bundles STILL LOAD: `apps/documents/project.js` bridges into the module
  for scope generation (`startProjectScopeWorkflow`,
  `renderProjectScopeBuilder`, `proposalBuilderScopeForTemplate`) and the
  customer portal renders historical signed proposals through
  `Portal.modules.proposalsTab`. Remove those bridges before ever deleting.
- `platform.proposals` / `platform.proposal_agent` capability defs are labeled
  "(Legacy)"; the built-in `proposals_only` and `sales_crm` presets now enable
  `platform.documents` (+ esign/templates studio) instead.

## 3. Data-driven New button

`portal/index.php` `initNewMenu()`:

- Static actions: `project`, `contact`, `report`, `document`, `payment`,
  `appointment`, plus **dynamic `doc:<type_id>` actions** — one per registered
  document type, labels/icons from the documents catalog
  (`DocumentsAPI.catalog.get`), fallback labels derived from the id.
- `platform.new_button_mode` (select) chooses the default action; its options
  are generated in `v1/platform/capability_defs.ts` by importing
  `listDocumentTypes()` from `v1/documents/types/registry.ts` — registering a
  new document type automatically adds a `doc:<id>` option.
- **`platform.new_button_items` (NEW, type `multi_select`)** chooses which
  actions the selector menu lists (comma-separated string of action ids; empty
  = default menu). `multi_select` is a new capability value type
  (`capabilities.ts` — validated against options, stored as a comma-joined
  string) rendered as toggle chips in the Company Settings capability tab.
- Legacy `proposal` mode values normalize to `doc:proposal` client-side.
  Doc actions hide when `platform.documents` is off.
- Dispatch: doc actions fire `fm:new-project-workflow` with
  `{ workflow: 'document', documentType: '<type>' }`.

## 4. Doc-first flows: standalone documents + the project picker

Documents can exist WITHOUT a project. Backend:
`POST /v1/documents/organizations/:orgId/documents` creates an org-scoped
standalone instance (`project_id: ""`); `PATCH /documents/:id { project_id }`
attaches it to a project later (one-way — only unattached docs can attach).
Client: `DocumentsAPI.documents.createStandalone(orgId, body)`.

`apps/project-request/app.js` handles `workflow: 'document'`
(+ `documentType`):

- The project modal opens in **standalone mode**: `projectModalApps()` filters
  to ONLY the Docs tab (`docWorkflowStandaloneActive()`), and the right side
  goes **straight into the create wizard** — the embedded engine mounts with
  no project (`ensureEngine({ standalone: true })`, `project: {}` satisfies
  `requiresContext`) and creates via `createStandalone`. In standalone mode the
  engine skips the server list and tracks session docs locally
  (`rememberStandaloneDoc`).
- The flow opens with a **full-width chooser** ("Select a project for this
  document."): project search/select, "Start a new project", or "Create
  without a project". After a choice the chooser slides into the left column
  (`collapseDocPickerToLeft`, `data-doc-picker-mode` full → left) and the
  **create wizard renders INLINE in the right panel** — typed actions land on
  the params step, generic on the type selector — via
  `projectDocsTab.openNewDocumentInline` → engine embed
  `openCreateInline(host, prefill)` (`options.inlineHost` in
  `openCreateModal`; `.fmdx-inline-wrap` neutralizes the dialog chrome).
  Never a modal-over-modal, never the full gallery.
  "Start a new project" creates a `workflow_state: 'document_only'` shell via
  `ensureDocumentBaseProject()`; `document_only` was added to the
  meaningful-activity lists in `apps/projects/viewer.js` and
  `portal/scripts/core.js`.
- When a project lands, `continueDocWorkflowWithProject()` runs the handoff:
  capture the standalone docs FIRST (`captureStandaloneDocState()` — the
  reopen/remount destroys the standalone engine instance), close any open
  wizard, remount the engine under the project
  (`projectDocsTab.adoptProject()`), PATCH `project_id` on every session
  standalone doc, unlock the other tabs, and reopen the doc in the editor
  (or the wizard when none was created yet).
- **Drafts view (My Projects)** — the catch-all for unattached standalone
  docs: `portal.viewer` gains a fourth view mode (Stages/Tiles/List/**Drafts**,
  `projectView=drafts`, button gated on `platform.documents`). Tiles show
  "&lt;Type&gt; draft" + title + status/updated, backed by
  `GET /organizations/:orgId/documents` (`DocumentsAPI.documents.listStandalone`
  = documents with `project_id: ""`). Clicking a tile calls
  `Portal.modules.request.openDocumentDraft(doc)` → the doc-first modal in
  resume mode (`options.resumeDocument`): docs-only tabs, the doc open in the
  editor, compact left-column picker for attaching it to a project. The tile
  model carries a kind label so future draft kinds (payments, …) can join.
  The owner may relocate this view later.
- Feed: document **send/view/sign/complete/payment** events emit org-level
  work events even with no project (`recordDocumentEvent` → `emitWorkEvent`,
  project_id optional) and render in the org feed's activity stream;
  **document.created is deliberately not emitted** (`emit:false`) for any
  document, project or not.
- **Perf contract for the picker** (`loadDocPickerRows`): the project list is
  fetched ONCE per session into lightweight rows and NEVER bulk-written into
  `Portal.ProjectStore` — `ProjectStore.cache()` rewrites the entire store per
  call, and a cache-per-project loop froze the browser on large orgs. Only the
  SELECTED project gets cached. Cache invalidates on `fm:projects:refresh`.
  Guard: `public/v1/scripts/docs-picker-perf.mjs` (80-project seed, long-task
  budget).

## 5. Known follow-ups

- `apps/docs/project.js` still shows signed-proposal PDFs from the legacy
  system via platform refs; their "View Proposal" related action now lands on
  the Docs tab itself (alias) — harmless but could be hidden.
- The FRONTEND mirror option lists in `apps/settings/company.js` are static;
  keep them in sync with the type registry when adding document types.
- Docs-tab route params (`document`, `documentView`) only cover the media
  viewer; engine documents have no deep-link route yet.
