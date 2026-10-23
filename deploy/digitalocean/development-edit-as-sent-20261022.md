# Edit manually opens the document as sent — development, October 22, 2026

Three releases on the canonical branch `codex/consolidated-firstmeasure-20260923`:
- `4cf68f773517c69af6eb0f4db6ed610b58b1ef77` (commits `a74f5373`, `4cf68f77`; parent `c8ecbce6`): the feature.
- `8e4532405ede5db199132228770b6952bfcdbb8f` (commits `6fe5577c`, `8e453240`; parent `a355f795`): the portal page
  loads the editor (`portal/index.php` loads the document libraries itself; without the tag Edit manually fell back
  to the template editor), and a line's `variant_summary` is derived.
- `f1018f8a8ede46e467e94cb41dd07f686fa78e7d` (commits `ca960a23`, `f1018f8a`; parent `ac8bf3ce`): the editor opens
  above the portal's project window (z-index 2147483540, as Preview; the window is 2147483200) and fills
  `{placeholders}` in its hints (strings new to the catalog come back unformatted). Shipped as one payload from
  `a355f795`, so web got the second release's files with it.
[Architecture](../../docs/architecture/document-as-sent-editing.md).

**Why.** "Edit manually" at the end of the Documents tab's estimate workflow opened the document template, with its
variables showing. Jack wanted the finished document exactly as the customer would get it (the PDF), editable like
a document, with the values that come from data still live.

**What changed.**
- Edit manually opens `FMDocSentEditor` (`public/libraries/doc-sent-editor/`): the same static `FMDocRenderer`
  render the PDF is made from, from a traced resolution (`POST /documents/:id/resolve { trace: true }`).
- Values from the document's data (a line's name, quantity, amount; any stored param) are inputs: click, type,
  Enter (Tab moves to the next). `POST /documents/:id/as-sent { writes }` accepts only paths the document shows as
  inputs, parses the text the way the value is formatted, stores it through the data's input rule (a typed line
  amount becomes the line's unit price), saves with `patchDocumentInstance`, and returns the recomputed page.
- Totals and other calculated values are read only and say what they follow. Values from another record
  (customer, project, company) are read only, with "Type over it here" for this document only.
- Other text is edited in place (paragraph style, bold, italic, underline) and saved as one `props.blocks`
  override per node through the same route; bound values in it stay bindings. A later template change to that
  text, or a change to a typed-over record value, is flagged with Keep mine / Use theirs, never dropped.
- General mechanism: `FMDocModel.resolveBindings(..., { trace: true })`, projection rows carry `source_path`, rules
  per kind of data in `public/v1/documents/inputs.ts`. Renderer blocks and runs carry `data-block-index` /
  `data-run-index`.
- "Edit layout" in the editor's top bar still opens the template editor.

**Roles.** Worker, legacy (compatibility) and web, one role per run: other sessions activated their releases between
this rollout's staging and activation five times ("Active release changed"), which deploy.py refuses, so each refused
role was reshipped. Other sessions' later releases on web and worker were built on the live files and keep these
changes (audited file by file against the release). The **pool** web node was unreachable through the jump host for
the whole window ("No route to host" from 20:50 to at least 22:30; a sibling rollout reached it at 20:38), so it was
not updated. While pool is down, every legacy activation briefly returns 503 for portal pages (seen once here). Ship
pool when it is back: `ROLES=pool bash output/edit-as-sent-20261022/ship.sh` from the session worktree
(`.claude/worktrees/edit-as-sent-b947df`; its `base.txt` is `a355f795`, so the one payload carries all three).

**Tooling.** Scripts copied from `output/estimate-photos-20261022/`; `integrate.py` moved the shared checkout from
`c8ecbce6` to the release (one file, `documents/project.js`, merged into another session's unstaged working copy).
`manifest_bump.py` here also inserts the new `doc-sent-editor` bundle into a host's live manifest that predates it.

**Tests.**
- `tests/document-as-sent-editing.test.ts` (4): a quantity typed into the itemized roofing estimate changes the
  scope item, the line amount and the total, and the PDF harness prints the new total; a typed line amount prices
  the line exactly; totals and projections are refused; edited text keeps its values live, survives data changes,
  is flagged when the template changes it and can be reverted; a typed-over project title is kept and flagged when
  the project changes; doc-model provenance through components and repeaters.
- `tests/doc-sent-editor-browser.test.mjs` (2): real render in Chrome; inputs vs calculated values; a typed
  quantity writes the right path; edited text is saved with its binding.
- `tests/project-history.test.ts`, `tests/documents-versions.test.ts`, `tests/roofing-sales-documents.test.ts`
  pass. `tsc --noEmit` passes.
- `tests/documents-api.test.ts`: one failure that is not this release: "instances attach the default workflow"
  expects `sign`/`pay` steps that `scopedWorkflowSteps` (signup-sandbox/roofing-documents.ts, untouched here) no
  longer defines; signing and paying moved onto the document. Two other
  failures in an earlier run were the local disk filling up (ENOSPC) and passed on rerun.

**Verified on dev** (sandbox organization "Cedar Heron Test Co", project 68 Northfield Rd, a new draft
"As-sent check (browser)", `doc_4f146535eee44599b25c`; signed in as Sandbox Tester in the built-in browser):
- Review & send > Edit manually opens the as-sent editor over the project window: two pages, no `{{` anywhere,
  company, customer and address filled, each line's name, quantity and amount marked as data, subtotal and total
  marked as calculated.
- Typing $2,500.00 into the garage line ($1,990.00) saved, and the subtotal and total became $3,734.00. The stored
  line is quantity 5 at unit price $500.
- Typing 6 into that line's quantity (5 sq) made the line $3,000.00 and the total $4,234.00. Clicking the total
  explains it is calculated and offers no input.
- Changing the heading to "Your new roof · Itemized proposal" saved one `props.blocks` override with its template
  fingerprint; reopening the editor from a fresh page load shows it, marked as edited.
- The PDF the server generates for the document (the Download PDF / Send path, read with `pdftotext`) prints
  "Your new roof · Itemized", the $1,234.00 and $2,500.00 lines and Subtotal and Total $3,734.00 (taken before the
  quantity change).
- A host-side run of the same path on another new draft (`output/edit-as-sent-20261022/verify-dev.mjs`): a typed
  $1,234.00 into a $7,960.00 line moved the total by exactly -$6,726.00, and the PDF printed it.
- Not checked in the browser: the template-change and typed-over conflict prompts (covered by the tests), and the
  pool node.

**Not done here.** Labelling these edits "Edited manually" in the document version history: the history session's
`withDocumentChange` is not on canonical yet. Every as-sent edit is one `patchDocumentInstance` call inside
`editDocumentAsSent`, the one place to wrap (hand-over note left for that session).
