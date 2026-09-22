# Doc Editor → Google Docs Parity Roadmap

**Heads-up from owner (2026-08-12):** after this spec, the whole document system must work well ON MOBILE. When choosing between implementation approaches, prefer ones that survive touch/small screens (pointer events over mouse events, no hover-only affordances, dialogs that can become sheets, avoid fixed-width panels).

Agreed with owner 2026-08-11 (follow-up to `docs/doc-editor-qa-report.md`). Design principle: **copy Google Docs behavior** unless FirstMate has a reason to differ. Every feature lands with checks in `public/v1/scripts/doc-mode-qa.mjs`; `doc-editor-regression.mjs` must stay green.

## Tranche A — quick wins (DONE 2026-08-11, QA checks O1–O14 + H3)
- [x] Superscript / subscript (run.super/run.sub, Ctrl+. / Ctrl+,, Format ▸ Text; renderer vertical-align + 0.65× size)
- [x] Capitalization commands (lowercase / UPPERCASE / Title Case via docProjection.transformSelectionText — DOM-in-place transform, commit re-parse)
- [x] Custom line spacing + space before/after paragraph (spacing menu additions + dialog; block.space_before_pt/space_after_pt rendered as margins; fields added to parseBlocksFromParts preservation list)
- [x] Word count while typing (Tools toggle → .fmde-wordcount-chip, refreshed per command batch, click opens dialog)
- [x] Full special-characters browser (searchable, ~170 chars in 7 groups; replaced the old 20-glyph Symbols submenu)
- [x] Suggest-an-edit proper dialog (showSuggestEditDialog; window.prompt eliminated)
- [x] Bookmarks, Docs-style: .fmde-bookmark-flag marker at the line, click → Copy link / Remove, link dialog "link to heading/bookmark" select, #fmdoc-block:/#fmdoc-bookmark: internal links scroll in-document
- [x] RTL paragraph direction (block.direction → dir attr, Format ▸ Paragraph direction)

NOTE 2026-08-11: another session is concurrently editing firstmate-doc-editor.js (added catalog-gating to Insert ▸ eSignature/Drawing mid-day). Coordinate before large refactors; re-run both QA suites after any merge.

## Tranche B — structural editor features (DONE 2026-08-12, checks F1–F2g + P1–P10)
- [x] Find & replace full parity: non-modal panel (.fmde-find-panel), next/prev, live "n of m", CSS Custom Highlight API highlighting (::highlight(fmde-find)), match case, replace-one/all, Ctrl+F/Ctrl+H, cleared on close/mode switch
- [x] Outline sidebar (View ▸ Show document outline → .fmde-outline-panel overlay, click-scroll, live refresh)
- [x] Table of contents (Insert ▸ Table of contents → text node flagged props.toc_generated, internally-linked lines, re-run to refresh)
- [x] Multi-level lists: JS-computed data-marker in renderer (survives page splits — CSS counters can't), 1./a./i. + •/◦/▪ by indent level, Format ▸ Bullets & numbering ▸ Restart/Continue (block.list_restart/list_continue)
- [x] Borders & shading (block.border {width_pt,color,sides} + block.shading; Format dialog; page color in Page setup → settings.page_background)

## Tranche C — DONE 2026-08-12 (checks Q1–Q11, R1–R6, S1–S5, T1–T8; harness 143/143, regression 37/37)
Also done beyond the two items below: footnotes (metadata.footnotes + renderer fillFootnotes pass: injected sup markers skipped by parser via data-fmdoc-inline, per-page bottom strips, editable strip text via P.footnoteDirty commit path, renumber by document order, × delete; Insert ▸ Footnote + Ctrl+Alt+F; v1 limitation: strip overlays body bottom instead of reflowing); functional ruler (.fmde-ruler-ui sticky strip: draggable left/right margin grips (offset ±10px so they don't overlap the indent triangles — hard-won), first-line ▽ (block.first_line_indent_pt → renderer text-indent) and left-indent △ (block.indent steps) markers; margins commit through applyPageSetup); header variants (settings.header_options.different_first/different_odd_even + *_first/*_even page_region frames created on enable, renderer applyHeaderVariants pass + continuation cloning extended, options chip on header focus); pageless mode (View ▸ Pageless: settings.pageless + paper.size "fill" + body frame h auto + header/footer visible:false, toggles back cleanly).
BACKEND MOUNTED: registerCollabRoutes + registerVersionRoutes now wired in documents/api.ts; npm run check clean; test:documents 23/23, test:documents-collab 7/7, test:documents-versions 4/4.

## Tranches D + E — DONE 2026-08-12 (checks U1–U8, V1–V4, W1–W4; FINAL: doc-mode-qa 159/159, regression 37/37, doc-language-check 23/23, backend 23+7+4 all green; live-portal spot check clean)
- [x] HTML export: File ▸ Download ▸ Web page (.html) — editor-local static render + embedded styles, blob download (exportHtmlDownload)
- [x] Spelling & grammar: Tools ▸ "Spelling & grammar check" panel (suggestions/Ignore/Add-to-dictionary, ::highlight(fmde-spell/fmde-grammar)); FMDocLanguage script tag ADDED to portal/index.php + dev-editor.html
- [x] Autocorrect (Tools toggle, default on): dictionary typo fixes, sentence auto-capitalization, smart quotes, "1. "/"- " auto-lists, URL auto-link. HARD-WON: typing-format execCommands fragment typed words across single-char text nodes — every correction must select the word ACROSS nodes (selectWordBefore walk) and replay via preventDefault + execCommand; direct DOM mutation mid-beforeinput races the browser's pending edit and silently loses.
- [x] Version history UI: opts.versionsApi adapter → File ▸ Version history dialog (list/save-named/word-diff view/restore w/ autosave marker command); DocumentsAPI.checkpoints client; wired in project.js instance mounts
- [x] Compare: Tools ▸ Compare with version → diff(current, checkpoint) materialized as metadata.suggestions (block-level, existing accept/reject UI)
- [x] Collab phase 1 client: DocumentsAPI.collab.connect (SSE + 409-stale envelope resolution); editor opts.collab — hello/commands/presence handlers, local batches pushed at tracked revision (missed-replay + one retry), own-echo skip, remote colored name-tagged cursors, presence on caret move; wired in project.js. v1 limitation: remote edits share the local undo stack.

## Whole-spec status: ALL PARITY TRANCHES COMPLETE (A–E) as of 2026-08-12.

## EDITOR CONSOLIDATION — DONE 2026-08-12
Final architecture: ONE engine (FMDocModel/FMDocRenderer/FMDocEditor) → ONE shared visual-editor chrome (`public/libraries/visual-editor/firstmate-visual-editor.js`, global `FMVisualEditor`, 3,687 lines — the Web Editor's Canva chrome extracted move-not-rewrite) → consumed by Web Editor (app.js 4,103→2,239 lines; web-only pieces injected via adapters: portal/page templates, site-pages strip, portal element widgets, notes/upload meta, device toggle) AND all three document surfaces (studio template editor, studio folder items, project instance docs — `FMVisualEditor.mount` with `chrome:{contentKind:'document', upload:{...per-surface owner}}`, graceful FMDocEditor fallback). Chrome renders only in Visual mode; Doc mode keeps the word-processor menubar; Preview stays chromeless on the one shared renderer. Built-in Pages/Layers/Insert rail suppressed under chrome (`.fmve-chrome .fmde-rail`), kept for chromeless mounts. `firstmate-doc-editor.js` untouched by the refactor. Loading: index.php script tag after doc-editor + portal.web_editor manifest bundle + dev-editor.html.
Wrapper handle delegates the full editor handle + `editor` (raw), `setChromeTab`, `sectionRect`, `refreshChrome/refreshPages`, `setDevice`. `chrome.pages:'document'` = built-in doc-pages strip adapter (Add page → page.insert). Generic section templates + node builders are static exports (`FMVisualEditor.sections/builders/...`).
VERIFIED: doc-mode-qa **167/167** (new X1–X8 chrome-on-documents section), regression 37/37, docs-consolidation-e2e 25/25, marketing-folders-e2e 28/29 (1 fail = known Windows storage-race flake; crashes in some runs = same race hitting the harness's own API calls), web suites at exact baselines (e2e 14/16, chrome 70/71, uitest 47/49, crop 23/23 — all misses pre-existing). doc-agent-e2e is broken at BASELINE by commit ac3973d3's new `documents.workflow_authoring` capability gate (harness setup predates it) — spawned as a separate fix task, NOT related to this refactor. Live-portal verified: document template → Visual = full 7-tab chrome, Doc/Preview clean round-trip.

## EDITOR CONSOLIDATION (original plan, for reference)
Owner decision: ONE global visual editor (the Web Editor's Canva-style chrome, extracted), ONE document editor (doc mode, already built), ONE shared preview (FMDocRenderer, already shared). Workflows deliberately deferred. Web-only features must be explicitly declared/gated; default everything shared.

Editor inventory that motivated this (verified): one engine + one FMDocEditor library, but TWO visual shells — web-editor/app.js builds its own chrome (Templates/Elements/Media/Text/Brand/Markup/QR rail, ~lines 1671–3712) around the shared canvas, while studio.js/project.js visual mode shows the editor's built-in Pages/Layers/Insert rail. Workflow editor (studio.js renderWorkflowEditor) is bespoke, NOT engine-based. Legacy proposals builder still in tree, deprecated.

Plan:
1. (subagent, in flight) Extract chrome → NEW `public/libraries/visual-editor/firstmate-visual-editor.js` (global FMVisualEditor; wraps FMDocEditor.mount; chrome only in visual mode; `chrome` option: contentKind web|document, tabs subset, templates adapter — PAGE+PORTAL templates move to web-editor as web-only, generic SECTION templates stay in-library; pages-strip adapter ('document' default = doc pages); device toggle web-only-by-option; markup persist hook; qr/brand/notes hooks). Web-editor becomes a consumer with identical behavior; test hooks (__fmweEditor etc.) preserved. Gates: web-editor-e2e, web-editor-chrome, website-editor-uitests, doc-mode-qa 159, regression 37.
2. (after delivery) Wire document surfaces to FMVisualEditor: studio.js template editor (designer profile), studio folder items (incl. kind:view visual docs), project.js instance docs (visual mode gets chrome; doc mode untouched). Document-flavored template registry = layout blocks. index.php script tag (already agent's job) + new harness checks + all doc suites re-run.
3. Preview: no changes needed (renderer untouched) — verify per surface.
Then: workflows (deferred), legacy proposals deletion (owner already approved once flow validated).
- [x] Table editing in doc mode (checks Q1–Q11): plain cells contenteditable (.fmde-cell-edit), commits via node.set props.rows (innerText, \n preserved via td pre-wrap), Tab cell navigation, floating chip (.fmde-table-chip: rows/cols add/delete, merge-right/unmerge via cell.colspan, cell fill, delete table), drag column borders → width_frac (renderer stamps td data-cell="r:c"). GOTCHA: the chain-frame click-to-type pointerdown handler must exclude cells/images or it steals their clicks.
- [x] Image handling in doc mode (code in; checks R pending): click image → .fmde-img-overlay with SE resize handle (frame.h in pt = px/scale*72/96) + chip: In line / Wrap left / Wrap right (anchor {to_block: nearestFlowBlockId, wrap}) / Replace (host media picker) / Delete.

## Backend modules DELIVERED by subagents (NOT yet mounted — integrator wires into documents/api.ts)
- Language engine: public/libraries/doc-language/firstmate-doc-language.js (global FMDocLanguage: init/checkSpelling/checkGrammar/autocorrect/addToDictionary; nspell + SCOWL en_US vendored ~569KB; grammar = built-in precision rules — nlprule does NOT exist on npm; verify: scripts/doc-language-check.mjs 23/23). Must be added to portal index.php script tags when used in-portal (index.php gotcha).
- Collab phase 1: public/v1/documents/collab/{service,routes}.ts — registerCollabRoutes(app) INSIDE registerDocumentsApi; SSE stream /:documentId/collab/stream (hello/presence/commands + pings), POST commands {base_revision→409 stale+missed}, POST presence; document_collab_log table; 7/7 tests (npm run test:documents-collab).
- Version history: public/v1/documents/versions/{service,routes}.ts — registerVersionRoutes(app); checkpoints CRUD + /:a/diff/:b (block diff + word_diff, "current" supported); gzip ~4KB/checkpoint; retention keep-10+dailies-30d for auto; 4/4 tests (npm run test:documents-versions).

## Tranche C — renderer-heavy
- [ ] Full table editing in doc mode: cell text editing via the projection, add/remove rows/columns, merge cells, column resize, cell shading (BIGGEST parity gap)
- [ ] Image handling in doc mode: drag-resize handles, crop, wrap options (inline / wrap text / break text) — model float anchors exist, UI missing
- [ ] Footnotes (pagination interplay: reserved page-bottom area, renumbering — hardest renderer task in this tranche)
- [ ] Functional ruler: draggable margins + first-line/hanging indent + tab stops (requires tab-stop support in text model + renderer; NOT easy despite appearances)
- [ ] Different first-page + odd/even headers & footers (checkbox on header focus, like Docs, plus Page setup)
- [ ] Pageless mode (per-document toggle; reuse kind:"view" fluid layout machinery; owner wants it for Workflow/Web editor synergies + pageless contracts)

## Tranche D — engines (all free/open-source, client-side WASM, zero server load)
- [ ] Spellcheck with suggestion cards: Hunspell via WASM (hunspell-asm or nspell) + SCOWL/LibreOffice en_US dictionaries; custom dictionary per org/user
- [ ] Grammar: nlprule (Rust port of LanguageTool rules) compiled to WASM, runs client-side. Expectation set with owner: rule-based ≈ LanguageTool quality, below Google's ML grammar. NO paid engines, NO server-side inference.
- [ ] Autocorrect: auto-capitalize sentences, smart quotes, "1. "/"- " auto-list detection, auto-link URLs on space/paste (local rules + dictionary-backed typo fixes)
- [ ] Version history browser with visual diff. Storage decision (owner asked about memory): checkpoint-based, NOT per-keystroke — snapshot on publish/send/manual "name this version" + collapse periodic autosaves (keep last N + dailies). Definitions are small JSON (~50–200 KB); media is stored by reference and never duplicated, so cost per checkpoint is tiny. Stable block ids make block-level diff straightforward (added/removed/changed blocks + run-level word diff).
- [ ] Compare documents (falls out of diff + suggestions: diff two docs → emit suggested edits, like Docs)
- [ ] HTML export (renderer static mode already emits HTML; add "Web page (.html)" to download formats in studio/project hosts)

## Tranche E — real-time collaboration (phased; owner wants it, concerned about server load)
Phase 1 (covers ~95% of contractor use, negligible server cost):
- Presence + live cursors/selections over the existing SSE hub (tiny payloads, no polling)
- Server-serialized command log: each doc carries a revision; clients POST command batches with base revision; server orders, applies, rebroadcasts; clients rebase or refetch on conflict
- Per-block last-write-wins for concurrent text.edit on the SAME block (coarse conflicts clobber — acceptable at this phase; flag visually "X is editing this paragraph")
Phase 2 (only if real usage demands character-level merging):
- CRDT (Yjs) bridge for text nodes — bigger rework of the commit pipeline; do not start here.
Server-load notes for owner: SSE fan-out of <1 KB deltas; no per-keystroke server work beyond append+broadcast; thousands of orgs fine. The hard part is CORRECTNESS (same-paragraph concurrent edits, undo semantics, reconnect/replay), not load — hence phasing.

## Explicitly deferred / rejected
- Editor-shortcut focus scoping (component-scoped by design)
- Ctrl+Shift+C DevTools collision (Docs parity wins)
- .odt/.rtf/.epub exports (unknown demand)
- Offline mode (future FirstMate browser-extension project, separate effort)

## Standing gotchas for implementers
- `parseBlocksFromParts` whitelists which block fields survive a DOM re-parse — EVERY new block field must be added to its preservation list or typing wipes it.
- `editor.getDocument()` deep-clones; never mutate-then-setDocument(getDocument()).
- Doc-mode hints render in `.fmde-hint`. Auto page numbers are `.fmdoc-auto-page-number` overlays.
- Blank chain docs via `FMDocModel.createBlankDocument()` for doc-mode testing; seeded templates have no chains.
- Editor CSS is EMBEDDED in firstmate-doc-editor.js (self-injected style tags); doc-editor.css is only the dev-harness mirror.
