# FirstMate windows

Load `window-manager.js` before an app that uses windows. It exposes
`window.FirstMateWindows.attach(options)` and has no Channels dependency.
The portal and app manifest load it before Channels. Conversations and calls
are its first consumers.

The manager owns geometry, pointer and keyboard resizing on all eight handles,
dragging, focus stacking, four title-bar controls, a title menu, pin state,
minimization/restoration, maximization, and coordinated right docks. Apps own
their content, routing, and what Close means. Maximization fills the host's
available workspace; it does not invoke the browser's native fullscreen API.

```js
const windowController = FirstMateWindows.attach({
  element: frame,                 // Existing frame, already mounted in host
  header, title, body,             // Existing title bar, title node, content node
  host: document.querySelector('main.main'),
  contentTarget: document.getElementById('mainPanels'),
  name: 'inspector',               // Accessible control labels
  label: 'Inspector window',
  mode: 'floating',                // floating | docked | full | minimized
  width: 640, height: 520, dockWidth: 420,
  minWidth: 320, minHeight: 280,
  topInset: () => document.getElementById('platformTopbar')?.offsetHeight || 0,
  onChange: ({mode, pinned, reason}) => {
    // Register route keys/handlers in the app. Use Portal.navigation.replace
    // for these adjustments, suppressing writes during history restoration.
  },
  onClose: () => {
    // Close the app's routed surface, finish its session, or destroy the window.
  }
});
```

`setMode(mode, {silent:true})` and `setPinned(value, {silent:true})` restore app
state without emitting `onChange`. `restore()` returns a minimized window to
its previous mode. Floating dimensions and position survive minimize, dock,
and maximize transitions. The maximize control becomes Float when maximized.

Minimized chrome offers explicit Float and Dock destinations with distinct icons,
regardless of the previous mode. The programmatic `restore()` method still restores
the previous mode when an app reopens its window.

The right-side controls are:

| Current mode | Controls, left to right |
| --- | --- |
| Floating | Dock, Minimize, Maximize, Close |
| Docked | Float, Minimize, Maximize, Close |
| Maximized | Dock, Float, Minimize, Close |
| Minimized | Float, Dock, Maximize, Close |

Click/right-click the title or press Alt+Space for the window menu, including
Pin/Unpin. Pin state is exposed to the app; Channels uses it to keep a maximized
conversation open across app switches. The manager never silently closes windows
when another app activates. Floating windows stack above docks; minimized windows
remain available above both. Transient menus/dialogs stay above the window layers.

`setVisible(false)` hides a reusable window and releases its reserved space.
`rehost(host, contentTarget)` moves a live window without recreating its content.
`focus()` brings it forward; `refresh()` recomputes its host layout.
`destroy()` removes the frame, controls and listeners and releases reservations.
An omitted `onClose` hides the window. Applications can await asynchronous cleanup
inside `onClose`; the X is disabled until it settles.

Multiple docks share a width budget that leaves page content available. The
manager restores the content target's original inline width and margin when no
docks remain, and observes host resizing (including a locked sidebar changing
width). Add `data-window-secondary` to app toolbars that should hide on minimize.
Use `data-theme="dark"` on a frame for the call theme.

## Channels lifecycle

A call opened from a floating/docked conversation lives directly under the main
workspace. A call opened in full Channels can remain inside that surface. Moving
or closing its conversation detaches the live call without stopping media.
Closing the conversation preserves its instance while that call is active;
closing/leaving the call stops media and releases that hidden instance.

Browser regressions live in `public/v1/scripts/channels-workspace-e2e.mjs`.
`CHANNELS_LAYOUT_ONLY=1` runs focused window/profile checks, including eight
handles, restore from all three modes, shared dock bounds, independent call
dragging, and conversation-close versus call-close API behavior. Running without
that flag also tests media, effects, clips and two real WebRTC peers using test
devices and isolated API fixtures.
