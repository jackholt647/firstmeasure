# Edit manually opens the document as sent — development, October 22, 2026

Releases `4cf68f773517c69af6eb0f4db6ed610b58b1ef77` (commits `a74f5373`, `4cf68f77`; parent `c8ecbce6`) and
`8e4532405ede5db199132228770b6952bfcdbb8f` (commits `6fe5577c`, `8e453240`; parent `a355f795`), on the canonical
branch `codex/consolidated-firstmeasure-20260923`. The follow-up adds the editor's script to `portal/index.php`
(the portal page loads the document libraries itself; without it Edit manually fell back to the template editor)
and makes a line's `variant_summary` derived.
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

**Roles.** Worker, legacy (compatibility) and web. The **pool** web node was unreachable through the jump host for
the whole rollout window ("No route to host" from 20:50; a sibling rollout reached it at 20:38), so it was not
updated. dev.1m8.ai kept serving. Ship pool when it is reachable:
`ROLES=pool bash output/edit-as-sent-20261022/ship.sh` from the session worktree
(`.claude/worktrees/edit-as-sent-b947df`).

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

**Verified on dev.** See below.
