# Doc-Mode Editor QA Report — 2026-08-11

Full audit of the FirstMate doc editor's **Doc mode** (the Google-Docs-style word-processing surface in `public/libraries/doc-editor/firstmate-doc-editor.js`): complete feature inventory, live testing of every feature, bug fixes, and a Google Docs gap analysis.

**Test evidence:** `public/v1/scripts/doc-mode-qa.mjs` (NEW — 83 checks, all passing) + `public/v1/scripts/doc-editor-regression.mjs` (pre-existing 37 checks, all passing). Both run against the live dev harness with real mouse/keyboard input and assert against both the DOM and the DocModel. Fixes were additionally spot-verified in the real Doc Studio (portal `documents_studio` tab).

---

## 1. Feature inventory (what we offer in Doc mode)

### Toolbar
Mode segmented control (Visual/Doc/Preview) · Undo/Redo · Print · Spelling & grammar toggle · Paint format · Zoom (out/%, presets 50–200, fit width, fit page, in) · Named-style dropdown (Normal text/Title/Subtitle/Heading 1–3 + Clear, live preview, caret-reflective) · Font family dropdown (7-font catalog, caret-reflective) · Font size (−/value/+, presets 8–72, clamp 6–96, caret-reflective) · Bold/Italic/Underline (caret-reflective active states) · Text color + Highlight color (60-swatch Docs-style grid + custom picker + none, live color bars) · Insert link · Add comment · Suggest an edit · Add media/video/widget menu · Paragraph alignment (left/center/right/justify) · Line spacing (1/1.15/1.5/2) · Checklist/Bulleted/Numbered lists · Indent/Outdent · Clear formatting · responsive More-overflow menu (whole groups migrate, no duplicates) · Margins presets · Page numbers · Dictate (host-gated) · profile badge + Unlock design.

### Menu bar (Doc mode only)
- **Menus** button = command palette over all menu commands (also Alt+/).
- **File**: New, Open, Make a copy, Share, Email, Download (PDF/.doc/.txt/.json), Rename, Move, Move to trash, Version history, Page setup, Print. (Host-implemented; graceful "unavailable here" hint otherwise.)
- **Edit**: Undo, Redo, Cut, Copy, Paste, Paste without formatting, Select all, Delete, Find & replace.
- **View**: Mode switch, Comments toggle, Collapse side panels, Print layout, Ruler, Non-printing characters, Full screen.
- **Insert**: Media, Widget catalog, Table (3×3), Drawing (→ Visual mode), eSignature field, Audio, Symbols (20 glyphs), Link, Horizontal line, Page break, Bookmark, Header, Footer, Page numbers, Comment.
- **Format**: Text (Bold/Italic/Underline/Strikethrough), Paragraph styles, Align & indent (incl. Justify), Line & paragraph spacing, Bullets & numbering, Headers & footers, Page numbers, Page orientation, Clear formatting.
- **Tools**: Spelling & grammar, Word count, Review suggested edits, Translate with Agent, Voice typing, Document Agent, Accessibility (only when the host implements it).
- **Help**: Search the menus, Ask the document Agent, Keyboard shortcuts (searchable dialog).

### Keyboard shortcuts
Ctrl+Z/Y/Shift+Z (history) · Ctrl+B/I/U · Alt+Shift+5 (strikethrough) · Ctrl+K (link) · Ctrl+H (find/replace) · Ctrl+Shift+C (word count) · Ctrl+/ (shortcuts dialog) · Alt+/ (menu search) · Ctrl+P (print) · Ctrl+O (open) · Ctrl+Alt+M (comment) · Tab/Shift+Tab (indent) · Ctrl+Enter (page break) · Ctrl+Shift+L/E/R/J (align) · Ctrl+Shift+7/8 (lists) · Ctrl+Shift+./,(font size) · Ctrl+\ (clear formatting) · Escape (commit+blur) · Ctrl+wheel (zoom).

### Engine-level
Real contenteditable projection over the paginated renderer; idle-commit (150 ms) with immediate commit on frame overflow; caret survives repagination (logical block/offset restore); live pagination with widow/orphan control; explicit page breaks (insert + backspace-merge + undo round-trip); auto-repeating headers/footers (edit once, repeats everywhere); click-anywhere-to-type page regions; multi-block selection operations across page-split frames; cross-node merge on backspace; one 200-entry undo log shared across typing/formatting/structure; find & replace (replace-all); word count; page setup dialog (paper size/orientation/margins/page-style themes); page numbers (position/align/format/start/first-page, rendered overlay); comments (threads, replies, resolve) + suggested edits (accept/reject with conflict check); dictation; document Agent; profile rails (designer/document/fill/inline/website) with per-node locks; autosave via host (400 ms editor debounce + host debounce + optimistic concurrency).

---

## 2. Bugs found and FIXED (14)

All in `public/libraries/doc-editor/firstmate-doc-editor.js` unless noted. Each is covered by a new check in `doc-mode-qa.mjs`.

1. **Enter inside a numbered/checklist item dropped the list marker.** `text.split_block` copied align/style_ref/level/indent to the new block but not `list_style` (or `line_height`) — every Enter in a numbered list produced a bullet-looking item and broke numbering. Fixed the command's tail-block copy.
2. **Typing format never followed the caret (over-sticky).** Pick Georgia once and every paragraph you clicked into afterward typed Georgia; worse, the always-truthy defaults (`#202124`/`transparent`) meant typing inside colored text produced default-colored characters. Added `syncTypingFormatFromCaret()` on a debounced document `selectionchange` (Google-Docs semantics: pending format mirrors the caret; explicit choices override until the caret moves).
3. **Toolbar never reflected the caret's formatting.** Font family, size, named-style label, B/I/U active states, and the color indicator bars were static. Added `updateDocToolbarFromCaret()` fed by the caret sync (also converted the size stepper to read live state instead of a stale closure variable).
4. **Format ▸ Paragraph styles was a dead menu item** — it clicked a toolbar button by a title that doesn't exist. Now opens the named-style picker.
5. **Ctrl+K / Insert ▸ Link never applied the link** — the dialog input stole the document selection, so `createLink` had nothing to act on. The dialog now snapshots the range and restores it before applying. Also unified the toolbar link button on the same dialog (was a bare `window.prompt`).
6. **Insert ▸ Horizontal line silently did nothing in the document profile** — the `shape` insert was rejected by the designer-only `shapes` feature gate. Flow-anchored hairline rules (≤2 pt) are now treated as body copy under `text_style`.
7. **View ▸ Show non-printing characters was dead CSS** — the pilcrow rule targeted `[data-block-type=paragraph]`, an attribute the renderer never emits. Retargeted to `.fmdoc-block--paragraph`.
8. **Page numbers dialog defaulted to "Hide" on first open** — `enabled: !!current` turned "nothing stored yet" into false, so Apply did nothing. First open now defaults to Show.
9. **List/font-size shortcuts broken on real keyboards** — handlers compared `ev.key` to "7"/"8"/"."/"," but with Shift held those keys produce "&"/"*"/">"/"<" on US layouts. Now also match `ev.code` (Digit7/Digit8/Period/Comma).
10. **Paint format copied paragraph defaults instead of the text's style** for paragraph-level selections (triple-click / select-all-of-block anchors on the block element). `captureFormatting` now walks to the first real text run inside the selection.
11. **Strikethrough existed in the model, parser, and renderer but had zero UI.** Added Format ▸ Text ▸ Strikethrough, Alt+Shift+5 (Docs binding), typing-format support, and a shortcuts-dialog entry.
12. **Tools ▸ Accessibility appeared in every host but no host implements it** — always ended in "unavailable here". The item now renders only when the host provides the action.
13. **Edit ▸ Paste / Paste without formatting were broken** — `execCommand("paste")` is blocked in modern browsers, and "without formatting" inserted the current *selection*, not the clipboard. Both now use the async clipboard API with a "Press Ctrl+V" hint when access is denied.
14. **Model hygiene: typed spaces persisted as `&nbsp;` and colors as `rgb()` strings.** execCommand wraps typed spaces as non-breaking at inline boundaries (breaks search/word-count semantics), and computed styles round-tripped as `rgb(...)` while palette picks stored hex. The DOM→model parser now normalizes both (nbsp→space, rgb→hex).

Also fixed opportunistically:
- **Insert ▸ Media…/Audio… blindly fired `items[0]`** of the insert menu — if the media picker was unavailable (images feature off), it silently inserted a 3×3 table. Now selects the media item explicitly and hints when unavailable.
- **Justify** was reachable only via Ctrl+Shift+J; added it to the alignment dropdown and Format ▸ Align & indent (with shortcut hints on the dropdown).

## 3. Bugs/limitations found but NOT fixed (with reasons)

1. **Table cells are not editable in Doc mode.** Tables insert and render, but the projection only makes chain *text nodes* editable; editing cell content requires the Visual mode inspector. Fixing means teaching the projection to serialize table-cell DOM back to `props.rows` — a feature build, not a bug fix. (Biggest single gap vs Docs.)
2. **Bookmarks are write-only.** Insert ▸ Bookmark records `{node_id, block_id, offset}` in metadata, but nothing renders a marker, lists bookmarks, or links to them. Needs product design (likely pairs with a document outline).
3. **"Suggest an edit" uses `window.prompt`** and refuses multi-paragraph selections. Works correctly (verified add + accept + reject), but the UX is unpolished. Deferred as cosmetic.
4. **Editor shortcuts require focus inside the editor root** (component-scoped keydown listener). Matches embedded-component conventions; changing to document-level capture risks colliding with host surfaces (studio trays, agent panel). Left as designed.
5. **Ctrl+Shift+C (word count) collides with DevTools' element-picker** when DevTools is open. Kept for Google Docs parity.
6. **Menu "Paste" cannot paste rich content** — the async clipboard text API is the only programmatic path; rich paste works natively via Ctrl+V (re-parsed into runs). Inherent browser limitation.
7. **The ruler is decorative** (a CSS tick strip) — no draggable margins or tab stops. Feature build.
8. **Numbered lists don't show multi-level markers** (1. → a. → i.) and indenting doesn't rotate bullet glyphs; nesting is visual only. Feature build in the renderer's counter CSS + list model.

## 4. Google Docs features we don't offer (gap list)

**High-impact / commonly used**
- Table *editing*: add/remove rows & columns, merge cells, column resize, cell shading (we only insert a fixed 3×3 and edit in Visual mode).
- Document outline sidebar + linkable headings/bookmarks navigation.
- Find & replace navigation: find-next/previous with match highlighting and match-case (we do replace-all only).
- Real-time collaboration: multi-cursor presence, suggesting *mode* (every edit becomes a suggestion), comment @mentions/assignments. (We have single-user comments + one-off suggested edits.)
- Image handling in Doc mode: drag-resize, crop, text-wrap options (inline/wrap/break). Model supports float anchors; no UI. (Available via Unlock design → Visual.)
- Autocorrect & auto-format: auto-capitalize, smart quotes, "1. " / "- " auto-list detection, automatic link detection on paste/type.
- Multi-level list styles and numbering control (restart at, continue, style variants).
- Spelling/grammar *suggestions* (we toggle the browser's spellcheck squiggles; no suggestion cards, custom dictionary, or grammar).
- Footnotes.
- Table of contents (auto-generated from headings).
- Page-less mode (we do have a separate `view` doc kind for fluid pages, but not toggleable per document).
- Columns (Format ▸ Columns; our chains are single-column — repeaters support columns but not body text).

**Medium**
- Superscript/subscript (no run model support).
- Capitalization commands (UPPERCASE/lowercase/Title Case).
- Custom line-spacing value + space-before/after paragraph controls (we have 4 presets; the model supports `space_before_pt`/`space_after_pt` via named styles only).
- Border & shading (paragraph borders, page color).
- Full special-characters browser (we offer 20 symbols) and emoji picker.
- Word-count-while-typing indicator.
- Ruler-driven indent/tab-stop manipulation.
- Version history *browser with visual diff* (hosts expose snapshot lists; no in-editor diff).
- Different first-page / odd-even headers & footers.
- Compare documents.
- Download as .odt/.rtf/.epub/.html (we offer PDF/.doc/.txt/.json).
- RTL text direction.

**Low / product-covered elsewhere**
- Explore/Gemini panel → covered (arguably better) by the Document Agent, incl. translate.
- Smart chips/building blocks → partially covered by FirstMate widgets (signature, payment, QR, form fields — things Docs *can't* do).
- Drawings → Visual mode covers this natively.
- Offline mode, Docs API/add-ons ecosystem — out of scope.

---

*QA account used: `docqa-owner@example.test` / org `org_docqa_2026` (full_platform preset) on the local stack. Re-run any time with:*
```
cd public/v1 && node scripts/doc-mode-qa.mjs && node scripts/doc-editor-regression.mjs
```
