# Shared Markdown and document content

`public/libraries/doc-markdown/firstmate-markdown.js` is the sole Markdown
representation library for document adapters and agent-facing text. It exposes
`FMMarkdown` in browsers and the same exports through CommonJS. It has no
network or third-party runtime dependencies.

## Contract

- `parse(text)` returns `{version: 1, blocks}`. Blocks are paragraphs, headings,
  nested lists (with start numbers and optional task state), quotes, tables,
  fenced code and rules. Text uses runs with text, weight, italic, strike, link
  and code marks. Parsing is bounded to 256 KiB and sixteen nested levels.
- `render(text | content)` produces escaped semantic HTML in `.fm-markdown` and
  installs the shared scoped stylesheet. Raw HTML is displayed as text. Links
  permit HTTP(S), mail, telephone and fragment destinations; there are no remote
  image fetches or executable attributes. Attachments keep their own contracts.
- `stringify(content)` produces the supported Markdown dialect. This is a
  bounded application dialect, not a claim of complete CommonMark support.
- `toDocNodes(text | content, {generateId})` maps content to existing DocModel
  text, table and flow-frame nodes. Use `FMDocModel.generateId` when inserting
  into a document. Imported runs are literal prose, not template expressions.
- `fromDocNodes(nodes)` returns `{content, diagnostics}`. Markdown cannot retain
  page geometry, visual formatting, widgets, merged cells or executable bindings.
  Export reports those limits and never replaces the source document.
- `listMarker(style, count, level)` is the document-derived marker rule shared
  with the document renderer: decimal/alphabetic/Roman numbered levels and
  disc/circle/square bullet levels.

Documents remain structured DocModel content. Markdown is an interoperable text
representation, not a replacement for the document engine or publication layer.
The editor provides File > Insert Markdown and File > Export Markdown, plus
`handle.insertMarkdown(text)` and `handle.exportMarkdown()`. Import inserts flow
nodes through the existing command engine in one undo operation and respects
the editor's text-editing policy. Ordinary paste keeps its existing behavior.
The print/PDF harness embeds this library alongside the model and renderer.

## Consumers and boundaries

Agent Chat, the global assistant's replies/text panels, Stats agent replies and
Checklists descriptions call `FMMarkdown.render`. Document Agent and Insights
already reuse Agent Chat, so they inherit the same rendering. Shells still own
message bubbles, action chips, streaming placeholders and attachment behavior.
The portal, customer document/presentation pages, Sites and document development
harnesses load the library before its consumers. Agent message text and storage
remain unchanged; historical text is rendered through the shared implementation.

Channels, Feed and project-note message rendering retain their existing Channels
Markdown implementation for the next migration. Its mentions, message identity,
table-preview expansion, custom width encoding and draft serialization require
an explicit compatibility adapter. Do not copy that parser into new apps.

## Verification

Run from `public/v1`:

```sh
node --test tests/shared-markdown.test.mjs tests/shared-markdown-browser.test.mjs tests/agent-chat-ui-contract.test.mjs
```

Behavior tests cover nested round trips, escaped URLs/HTML, literal code,
document adapter validation, quoted tables/lists, numbered starts, editability
and undo. Existing assistant/widget and presentation browser checks verify that
the dependency and richer text rendering do not disturb those surfaces.
