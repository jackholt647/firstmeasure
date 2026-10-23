# Estimate workflow: rich text descriptions and the photo picker — development, October 22, 2026

Release `77d8a0404aa64c83a134783da6741b4a27bdf3ab` (branch `claude/estimate-photos-richtext-42ad04`, integrated into
`codex/consolidated-firstmeasure-20260923`). Production is unchanged.

## Photo picker: what was broken

Jack saw blank tiles in the "Photos & description" step and on line items, uploads that seemed to work but never
showed a thumbnail, and picks that added nothing. There were three causes:

- **Blank tiles.** The documents app passed the shared picker the media library records exactly as `GET /media`
  returns them, where the media id is `id` and there is no `media_id` or URL. The picker builds its thumbnail URLs
  from `media_id`, so every tile was an empty `<img>`. The picker (`photos/feed.js`, `libraryRecordPhoto`) now reads
  a library record's `id` as its media id, and the documents bridge gives each item a `media_id`. The bridge also
  lists only photos and videos, with this project's media first.
- **No inline library.** Commit `f9c96068` reset `feed.js` to a live baseline and removed `mountProjectMediaPicker`.
  The `media.picker` widget (the library inside the attach popover) therefore threw on every page, and the existing
  `document-attach-library-browser` test was failing. The function is restored as the single picker implementation:
  the modal wraps it.
- **Thumbnails 404.** Thumbnails are only rendered for images 1024 px or larger, and GIFs never get one. The
  workflow asked for `thumb_320` regardless, got a 404, and showed a placeholder. That made a successful upload or
  pick look like nothing happened. Both media stores (`platform/media_variants.ts`) now serve the original image
  when a `thumb_N` rendition was never made. A video without a poster still returns 404.

Two more changes:

- **A pick is assigned at once.** Picking from the library assigns the photo straight away, with no second Save in
  the popover. Before, clicking outside the popover after picking threw the pick away.
- **Failures are visible.** A failed upload shows its reason inside the picker. Before, the upload threw an unhandled
  rejection and showed nothing. A picker that cannot open shows an error in the attach popover; before, the error was
  swallowed.

## Rich text descriptions

- **Editor.** The content-block body uses the shared Channels/Notes editor
  (`FirstMateChannels.composerWidgets.createEditor` and `formatBar`): bold, italic, strikethrough, lists, links,
  tables, quote, code, clear formatting, plus the shared GIF picker button. The body is stored as that editor's
  Markdown, and old plain-text bodies load unchanged. A picked GIF is kept as `block.gif` and shows under the text.
- **Rendering.** A bound text run with `format: "markdown"` resolves through `FMMarkdown` in DocModel into
  paragraphs, lists and tables. The run carries the source block's style, so the document, PDF harness and live
  preview all show the formatting.
- **Template and revisions.** `media_text_row` uses this for the body and adds the GIF image and "Powered by GIPHY".
  `DOCUMENT_PRESET_REVISION` is 36 and `INSTANT_ROOFING_PACK` is 16, so organizations' presets and roofing packs
  republish. Drafts pinned to an older template version still render the body as plain text, so Markdown symbols
  show there.
- **Presentation.** The roofing presentation decks have no slide that shows the content blocks, so the description
  does not appear in the presentation either before or after this change.

## Tests

- **New.** `tests/document-workflow-content-blocks-browser.test.mjs` has four tests:
  - inline library pick
  - modal library pick: without the fix the tiles were `["",""]`
  - upload, and an upload failure message
  - the rich text toolbar writes Markdown, and the document renders bold, bullets and a table
- **New.** `tests/content-block-rich-text.test.ts` covers the roofing template resolving Markdown, the GIF, plain text,
  and the thumbnail fallback rules.
- **Fixed.** `tests/document-attach-library-browser.test.mjs` passes again: it had been failing since `f9c96068` and
  now expects immediate assignment.
- **Type check.** `npm run check` passes.
- **Failures that are not from this release.** Each of these also fails on unmodified HEAD:
  - roofing-sales-documents: all 11 pass. documents-api, production-documents, documents-versions, media-tags and
    workflow-sections have 2 failures:
    - "instances attach the default workflow"
    - "change order, invoice and completion certificate"
  - the UI-contract suites (documents-studio, workflow-builder) have the same 26 failures.

## Rollout

- **Integration.** `output/estimate-photos-20261022/integrate.py` merged into the shared checkout. The working copy of
  `apps/documents/project.js` held another session's hunks, and the merge kept them.
- **First attempt.** Another session activated the worker in between, so the first activation was refused before
  anything changed.
- **Pool down.** The pool node (`do-603124965`, 10.124.16.3) then stopped answering ("No route to host" from web) and
  left the load balancer. Other sessions hit the same error.
- **Three roles shipped.** The release went to **worker, legacy and web** only, with 3-way merges onto the live
  releases of other sessions (`ab16a5c9`, `d8e2243f`). `rollout.py verify worker legacy web` passed for all three.
  **Pool still needs this release** when it is reachable again: `ROLES=pool bash output/estimate-photos-20261022/ship.sh`.
- **Host check.** `host-check.mjs` was run on web with `remote.py`. On the pilot organization, a `thumb_320` request
  for an image without one now serves the original. It works but is heavy: the original was a 2 MB logo. The roofing
  template resolves Markdown on the server (2 list items, 1 table), and the revisions are 16/36. The served files
  contain every change.
- **Browser check not done.** The built-in browser was not signed in to dev and this session cannot enter a password,
  so the upload, pick, toolbar and output were not clicked through on dev. The browser tests above cover them against
  the real libraries.
