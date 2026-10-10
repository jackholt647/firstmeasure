# Platform picker widgets

`pickers.js` owns the emoji and GIF controls: rendering, styles, emoji groups,
search, GIPHY grid, anchored popovers, keyboard dismissal and cleanup. It can
run without `channels-ui.js` or the full widget catalog runtime.

`grouped-widgets.js` registers `emoji.picker` and `gif.picker` using these same
controls. Channels loads this module on demand for composer insertion, message
and huddle reactions, and channel/thread GIF sends. Channels retains only the
delivery callbacks and thin GIF-button/emoji-mount adapters for existing Feed
consumers. The existing Feed rich-editor exports are retained.

Browser API: `window.FirstMatePickerWidgets` exposes `mountEmojiPicker`,
`openEmojiPicker`, `openGifPicker`, `createGifPickerButton` and `closeFor`.
Mounts and buttons expose `destroy()`. Popovers close when their trigger is
removed, on Escape, on outside interaction, or when another picker opens.

GIF hosts supply `orgId`, `onSend(gif, operationId)`, and optionally `onError`
or `getConfig(orgId)`. The default config transport uses Channels API's
authenticated GIF configuration endpoint, loading that API client if needed.
The widget never imports Channels UI or posts messages itself. Hosts own the
meaning of a selection; catalog widgets report a confirmed URL, while Channels
sends the selected GIF metadata through its existing message API.

Run `node --test tests/gif-picker-browser.test.mjs` from `public/v1`. Set
`DEV_ASSETS=1` to repeat against hosted dev assets with isolated fixture data.
