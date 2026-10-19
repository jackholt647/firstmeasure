# Platform picker widgets

`pickers.js` owns the emoji and GIF controls: rendering, styles, emoji groups,
search, GIPHY grid, anchored popovers, keyboard dismissal and cleanup. It can
run without `channels-ui.js` or the full widget catalog runtime.

`grouped-widgets.js` registers `emoji.picker` and `gif.picker` using these same
controls. Channels loads this module on demand for composer insertion, message
and huddle reactions, and channel/thread GIF attachments. Channels retains only the
delivery callbacks and thin GIF-button/emoji-mount adapters for existing Feed
consumers. The existing Feed rich-editor exports are retained.

Browser API: `window.FirstMatePickerWidgets` exposes `mountEmojiPicker`,
`openEmojiPicker`, `openGifPicker`, `createGifPickerButton` and `closeFor`.
Mounts and buttons expose `destroy()`. Popovers close when their trigger is
removed, on Escape, on outside interaction, or when another picker opens.

GIF hosts supply `orgId`, `onSelect(gif, operationId)` (`onSend` remains a compatibility alias), and optionally `onError`
or `getConfig(orgId)`. The default config transport uses Channels API's
authenticated GIF configuration endpoint, loading that API client if needed.
The widget never imports Channels UI or posts messages itself. Hosts own the
meaning of a selection; catalog widgets report a confirmed URL, while Channels
adds the selected GIF to a removable draft preview and sends its metadata only
when the user submits the composer.

Run `node --test tests/gif-picker-browser.test.mjs` from `public/v1`. Set
`DEV_ASSETS=1` to repeat against hosted dev assets with isolated fixture data.


## GIF display and attribution

Load `gifs.js` before rendering any GIFs. The portal shell, app bundles and widget
runtime include it. `FirstMateGifWidgets` has no Channels, Notes, Feed, API or
message-delivery dependency. It owns media URL validation, GIF cards, the supplied
35px attribution overlay, styling and removable draft previews.

- `createCard(gif)` returns a figure or null for an unsupported URL.
- `renderCard(gif)` returns the same component as escaped HTML.
- `createDraft(gif, onRemove)` / `renderDraft(host, gif, onRemove)` own draft UI.
- `renderDraftHtml(gif)` provides a draft whose `[data-gif-remove]` button the host
  can bind after inserting HTML.
- `mount(host, {gif, draft, onRemove})` returns `update(gif)` and `destroy()`.

GIF data is `{id, url, title, width, height}`. Hosts own sending, draft state and
placement; they must not reimplement the GIF image or attribution. Notes, photo
comments, Channels and Feed call this component. Existing Channels composer
helpers delegate to it as compatibility adapters. The `fm-ch-gif` and
`fm-ch-gif-draft` aliases preserve existing layout hooks; owned component styles
use `fm-widget-gif` and `fm-widget-gif-draft`.
