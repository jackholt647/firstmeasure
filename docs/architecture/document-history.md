# Document history

Every document system in the platform keeps a history of its versions:
estimates, proposals, contracts, change orders, invoices, generated documents
such as purchase orders and work orders, and the templates, themes and
workflows they are made from. The history is recorded by the documents engine,
on the server, for every save, with who or what made it. It is on for every
organization and has no switch.

Operations uses the native document workflow and normal document writers for both
proposals and the `scope_of_work` type. `operations.scope.complete` retains an
`operations_scope` snapshot and publishes its materials deliverable as an explicit
internal plan. The scope-only document becomes completed; a proposal remains in its
ordinary lifecycle and acquires no signature, acceptance or payment receipt. Readiness
requires an actual ledger publication, not just a browser flag or snapshot metadata.

Read this page before adding a writer that changes a document, a lifecycle step
(anything like send, present, sign or an "Edit manually" override), or a new
kind of document asset.

## Words

| Word | Meaning |
| --- | --- |
| **Subject** | What has a history: a document (`document`), a template (`document_template`), a theme (`document_theme`) or a workflow (`document_workflow`). |
| **State** | What a version is: the subject's whole stored record, less `revision`, `updated_at` and `updated_by_user_id` (kept on the revision row instead). A template's state also holds the definition it published. |
| **Revision** | One numbered version of a subject (1, 2, 3…). It stores either its whole state (a **checkpoint**) or a **patch** from the revision before it, and the sha256 of its state. |
| **Cut** | Why a revision exists: `created`, `baseline`, `edit`, `named`, `restore`, `present`, `present_choices`, `snapshot`, `pdf`, `issue`, `send`, `view`, `response`, `payment`, `sign`, `seal`, `complete`, `decline`, `void`, `expire`, `workflow`, `upload`, `manual_edit`, `publish`. |
| **Source** | Who or what made it: `person`, `agent`, `automation`, `module`, `generator` or `system`, from `history/source.ts`, plus an actor label for someone who is not a user (a signer's name, "customer"). |

## Where it lives

`public/v1/documents/versions/`

- `history.ts` is the revision log every subject records through: recording,
  folding, checkpoints, reconstruction and checksums. It knows nothing about
  documents.
- `patch.ts` is the structural diff: `diffJson`, `applyPatch`, `stableStringify`.
- `codec.ts` turns a payload into stored bytes. Every row names its
  `encoding` and `format`, so a compressor or a tokenizer for document
  vocabulary is added there as a new encoding and nothing else changes.
- `context.ts` carries what a write is part of (`withDocumentChange`).
- `service.ts` is the document layer: what a document's state and cut are,
  readable differences, viewing and restoring a version, named versions.
- `routes.ts` serves the History panel.

The store is the `document-checkpoints` SQL store (`document_versions.sqlite`
locally, the shared PostgreSQL pool on servers), schema version 2:
`document_revisions` and `document_revision_heads`. Schema 1's
`document_checkpoints` table (editor-only checkpoints of the working
definition, which nothing created automatically) is left in place unused.

## How a save becomes a revision

`saveDocumentInstance` (`documents/storage.ts`) is the one writer of document
records, so every change reaches the history: edits, workflow steps,
presenting, sending, viewing, signing, payments, voiding, uploads, agents,
automations and modules. It calls `recordDocumentSave`, which saves and then
records. Template, theme and workflow assets record from `createAsset`,
`patchAsset` and `publishAsset`. A new kind of document must save through
these writers; a new asset kind records through `recordAssetSave`.

A lifecycle step wraps its body in `withDocumentChange({ cut, documentId,
userId })`. Every save inside it lands in one revision with that cut: a send
that saves three times is one "Sent" revision. The outermost step names the
cut (a send that takes a snapshot is a send), and a change scoped to one
document never reaches saves of another. Without a declared change, the cut is
inferred: a first save is `created`; a status that moves to sent, viewed,
signed, completed, declined, void or expired cuts that lifecycle revision even
under a plain edit; a save that only replaces `signing.final_pdf_hash` is the
e-sign seal (`seal`); a change of responses is `response`; anything else is
`edit`. A signature is attributed to the signer by name.

Lifecycle steps wrapped today: `patchDocumentInstance` (edit),
`voidDocumentInstance`, `updateUploadedDocumentFields`,
`confirmUploadedDocument`, `issueDocument`, `createSnapshot`, `sendDocument`,
`generateDocumentPdf`, `recordDocumentOutput` (sign, payment or response),
`recordPublicDocumentView`, `updateDocumentWorkflowState`, a presentation's
choices (`present_choices` in `presentation-service.ts`) and restore. Starting
a presentation records a `present` marker with `markDocumentRevision`, which
records a moment even when nothing changed; a named version is a `named`
marker. "Edit manually" on the as-sent document (`editDocumentAsSent`) wraps
its write in `withDocumentChange({ cut: "manual_edit", documentId, userId })`,
so each override is an "Edited manually" revision; the outer change wins over
the edit that `patchDocumentInstance` declares.

### Folding rapid saves

Autosave writes on every pause in typing, so saves are folded into the newest
revision instead of cutting a new one when either:

- they belong to the same operation (same `withDocumentChange`), or
- the cut is `edit`, `view` or `response`, the newest revision has the same
  cut and the same actor, the last save was under 5 minutes ago and the
  revision began under 30 minutes ago.

A lifecycle revision never takes saves from another operation, so present,
send and sign each stay their own revision even within one sitting. A folded
revision counts its saves (`edits`).

### Checkpoints and patches

Revision 1 is a checkpoint. After that a revision is a patch unless:

- its cut is `sign`, `seal`, `complete`, `baseline` or `created`, or the status just
  became signed or completed: an executed state is stored whole, so it is
  rebuilt from one row;
- 32 patches have followed the last checkpoint; or
- the patches since the last checkpoint would outweigh a whole copy.

So any revision is rebuilt from one checkpoint and a bounded run of patches,
and reading is never more than about twice the cost of reading a whole copy.
Every rebuilt state is checked against the revision's sha256 of its canonical
JSON (`stableStringify`); a mismatch is an error, never a wrong version.

The head row keeps the newest state and the one before it, so a save diffs
without replaying the chain and a fold recomputes its patch. It is a cache: it
can be rebuilt from the revisions. A recording failure is logged and never
fails the document save; the next save diffs against the last recorded state.

### The patch format

A patch is a list of operations on paths of keys and indices: set
(`["s", path, value]`), delete a key (`["d", path]`) and splice an array
(`["a", path, index, deleteCount, items]`). Arrays are aligned by element
identity: an object's `id` when it has one (pages, nodes, blocks, line items),
otherwise its content; same-id elements are diffed recursively. A reworded
block in a 200-block document costs that block. `applyPatch(a, diffJson(a, b))`
equals `b` exactly; the tests check this over 7,500 random edits.

Measured (tests, 400 single-save revisions of a 60-line estimate with 40
content blocks): 21 checkpoints, 79 KB stored, against 781 KB for gzip whole
copies (10%) and 7.4 MB of JSON (1%). Folding makes real histories far shorter.

## Signed and executed versions

The e-sign ledger and seal (`documents/signing`, [document signing](document-signing.md))
remain the authority for what was signed: the signing package holds the sealed
content and PDF, and the history never touches them. The revision recorded
when a document becomes signed or completed is a checkpoint whose state
carries `signing.package_id`, `signing.content_hash` and
`signing.final_pdf_hash`, and rebuilds byte for byte (by checksum) to the
stored record. Viewing a sent or signed revision shows its frozen snapshot,
which for a signed document is the sealed content, not a re-render. A signed
document cannot be restored over.

## Reading history

`GET /v1/documents/organizations/:org/documents/:id/revisions` lists revisions
newest first, with cut, source and actor name, status, the snapshot a send or
sign froze, the top-level sections a revision touched and how many saves it
folded. A document saved before history existed gets a `baseline` revision of
its stored state the first time it is listed or saved; nothing older is
invented.

- `…/revisions/:seq` returns the exact state and the editable definition: the
  template version current when it was written (or its pin once sent) with its
  overrides applied.
- `…/revisions/:seq/view` renders it: its frozen snapshot for send, sign,
  complete, snapshot and pdf cuts; otherwise its state on that template version.
- `…/revisions/:a/diff/:b` (either may be `current`) reads field by field
  (inputs, responses, status, delivery, workflow…; line items matched by id;
  tokens never shown) and content block by block with a word diff, plus a
  count of layout changes.
- `POST …/revisions/:seq/restore` writes that version's title, inputs,
  overrides, theme, recipients and tags back as a new `restore` revision. It
  never rolls back delivery, responses or status, and history is never
  rewritten.
- `POST …/revisions` names the current version.
- `GET /v1/documents/history/:kind/:assetId/revisions[/:a/diff/:b]` for
  templates, themes and workflows.

The History button in the documents app (and the editor's History button
there) opens the History panel: the list, what changed since the version
before (or any other, or the current document), View, Restore and Save
version. The editor's Tools ▸ Compare reads the same history.

## Relation to project change history

[Project change history](project-history.md) is a separate append-only log of
changes to a project's real work (lists, scope, schedule). A document is not
real work, and its history keeps versions to view, compare and restore rather
than a list of changes, so the two are not merged. Both take their source from
`history/source.ts`.

## Not built

- Diff tokenization and compression beyond gzip
  ([optimization backlog](../optimization-backlog.md), "Document history
  payloads are plain gzip JSON").
- The head row's second copy and per-request actor-name lookups
  ([optimization backlog](../optimization-backlog.md), "Document history keeps a head copy per document").
- Retention: every revision is kept. Folding and patches keep this small; a
  pruning policy for very long histories would only ever drop unsigned,
  unnamed revisions between checkpoints.
- A History panel for templates, themes and workflows (the API records and
  diffs them).
- Folder items (media, files, visual documents) keep their own full copies in
  `document_folder_item_versions` and do not record here yet.
- Presentations are module instances with their own receipts; only their
  effect on the document (present, choices) is in the document's history.
