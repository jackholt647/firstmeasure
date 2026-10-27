# PDF viewer

`public/libraries/pdf-viewer/firstmate-pdf-viewer.js` is FirstMate's own PDF
viewer, `window.FirstMatePdf`. It replaces Chrome's built-in viewer in an
iframe, whose toolbar and file name drew over our own window chrome. It is a
self-contained script: it injects one `<style id="fm-pdf-viewer-style">`,
loads pdf.js 3.11.174 from cdnjs (or reuses `window.pdfjsLib`), loads
`libraries/markup/firstmate-markup.js` when markup is on, and loads pdf-lib
1.17.1 only for a download with markup.

The viewer fills its host (`position:absolute; inset:0` inside it; a static
host is made `relative` and restored on destroy) and draws nothing outside it.
The host may lay its own top bar over it on phones; pass `insetTop` so the
first page starts below it.

## Contract

```js
FirstMatePdf.version            // '20261027-…'
FirstMatePdf.load()             // Promise<void>: loads pdf.js once
FirstMatePdf.mount(host, options) // → handle
FirstMatePdf.config             // { pdfjsSrc, pdfjsWorkerSrc, pdfLibSrc, markupSrc } (override before mounting)
```

Options: `url` (same origin or CORS), `fileName` (downloads), `title` (aria
label), `initialPage = 1`, `zoom = 'fit-width' | 'fit-page' | number`
(1 = 100%), `thumbnails = 'auto' | true | false`, `markup`,
`onReady({ pageCount })`, `onPageChange({ page, pageCount })` (not fired for
the initial page) and `onError(error)`. Also accepted: `data` (bytes instead of
`url`), `withCredentials`, `insetTop` (px), `onChromeChange({ hidden })` (the
touch toolbar hid or showed) and `onMarkupToggle({ active })`.

`markup`: omitted or `{ enabled: false }` shows no markup UI.
`{ enabled: true, readOnly, load, save }`: `load()` resolves
`{ [page]: items[] }` with 1-based page keys; `save(pages)` receives the same
shape for every page that has or had markup (a cleared page is `[]`). Saves
are debounced 300 ms, run in order, and are flushed by `destroy()`,
`flush()`, turning markup off, a download with markup and the page being
hidden. If `load()` rejects, the document shows without markup editing, so a
save cannot overwrite markup that failed to load.

Errors carry `code`: `password`, `invalid`, `missing`, `network`, `library`,
`unknown` (and `encrypted` or `export` from a download with markup). The viewer
shows its own error card and calls `onError`; `ready` rejects with the same
error.

Handle: `ready`, `page`, `pageCount`, `setPage(n)`, `next()`, `prev()`,
`zoomIn()`, `zoomOut()`, `setZoom(modeOrNumber)`, `setMarkupActive(bool)`,
`markupActive`, `download({ withMarkup })`, `resize()`, `destroy()`. Also:
`zoom`, `zoomMode`, `element`, `setThumbnails(open)`, `setInsets({ top })`,
`getMarkup()`, `flush()` and `exportPdf({ withMarkup })` (a Blob, without
downloading). `download()` resolves `{ blob, fileName }`; with markup the name
gains `-markup`, without it the original bytes are saved unchanged.

## How it works

- **Pages.** Every page is laid out up front at its final size (one column,
  `#eef0f3` canvas, white cards). Pages are shown at the width of the
  document's most common page, so a stray landscape page never forces sideways
  scrolling at fit width; zoom percentages refer to that page. Pages within one
  viewport of the screen render to a canvas at devicePixelRatio × zoom (capped
  at 8 Mpx, 5 Mpx on touch devices); canvases more than two viewports away, and
  off-screen canvases after a zoom, are freed. During a zoom the existing
  canvases stretch and are re-rendered 180 ms after it settles.
- **Text.** pdf.js `renderTextLayer` draws a selectable text layer per page.
  Its positions scale with the page's `--scale-factor`, so zooming does not
  rebuild it.
- **Zoom.** Buttons, the zoom menu (fit width, fit page, presets), ctrl/cmd +
  plus/minus/0, ctrl+wheel and trackpad pinch zoom around the cursor; touch
  pinch scales the page column with a transform and commits on release.
- **Navigation.** The current page is the most visible one; PageUp/PageDown,
  Home and End move by page when the viewer has focus (and are not passed on to
  the host).
- **Phones** (host narrower than 560 px): fit width, the toolbar is only the
  page counter, no thumbnails, zoom by pinch. On touch devices the toolbar and
  markup button hide while scrolling and come back on a tap.

## Markup

Each page gets one `FirstMateMarkup.PhotoMarkup` instance in a
`.fm-pdf-markup` layer laid exactly over it, created when the page first comes
near the screen and kept until destroy. The instances' own docks are hidden;
one dock of the viewer drives them all. The viewer relies on these members of
`PhotoMarkup` — keep them when changing it: the constructor
`(root, { items, size, onChange })`, `items`, `tool`, `size`, `color`,
`active`, `setActive()`, `undo()`, `redo()`, `history`, `historyIndex`,
`drawing`, `erasing`, `eraserPoints`, `dragging`, `renderLayer()`,
`pushHistory()`, `emitChange()`, `saveTextSelection()`, `setColor()` and
`destroy()`, plus the classes `.fm-photo-markup-layer`, `.fm-photo-markup-text`,
`.fm-photo-markup-handle`, `.fm-photo-markup-text-size`,
`.fm-photo-markup-text-delete` and `.r-proposal-markupdock`.

- Only the page last pressed is `active`, so the instance's own ctrl+Z acts on
  that page; the dock's undo and redo act on the page last edited, and "clear
  page" on the page in view.
- A second finger cancels the stroke the first one started; two fingers pan
  and pinch, the wheel scrolls.
- Items use 0–1 coordinates on the page as shown. Text items also carry pixel
  sizes (`fontPx`, `naturalWidthPx`, `naturalHeightPx`): the viewer stores them
  relative to a page 1000 px wide and rescales the instance's items and undo
  history when the page's width changes, so text keeps its size on the page.
- A download with markup rasterises each marked page's items to a transparent
  PNG (the drawing of `renderPhotoWithMarkupBlob`: strokes, arrows through
  `arrowParts`, text boxes) at twice the page's point size and draws it over
  the page with pdf-lib, accounting for the page's `/Rotate`.

## Limits

- Canvas size is capped, so text at very high zoom (above roughly 300% on a
  large screen) is slightly soft; there is no tiled rendering.
- Thumbnails do not show markup. Text-box colours from a partial selection are
  exported in the box's main colour.
- Links, form fields and PDF annotations are not interactive (no annotation
  layer), and there is no search or rotate.
- `PhotoMarkup` adds a window `pointerup` listener per instance that its
  `destroy()` does not remove; one instance per page lives until the viewer is
  destroyed.

Run `node --test tests/pdf-viewer-browser.test.mjs` in `public/v1` for changes
here (it needs cdnjs for pdf.js and skips without it).
