# FirstMate windows

Load `window-manager.js` before an app that uses windows. It exposes
`window.FirstMateWindows.attach(options)` and has no Channels dependency.
The portal and app manifest load it before Channels and Assistant. Conversations,
calls, and the global assistant use the same controller.

The manager owns geometry, pointer and keyboard resizing on all eight handles,
dragging, focus stacking, four title-bar controls, a title menu, pin state,
minimization/restoration, maximization, and coordinated side, corner, top and bottom docks. Apps own
their content, routing, and what Close means. Maximization fills the host's
available workspace; it does not invoke the browser's native fullscreen API.

## Tray headers and tabs

Load `window-shell.js` after `window-manager.js`. `FirstMateWindowShell.trayWindow`
gives docked trays the same title-bar sizing, tab navigation, and content-panel
contract. Pass its returned `body` to `FirstMateWindows.attach`; the shell moves
each supplied element into a retained panel. One tab hides the tab bar; adding a
second tab shows it. Arrow, Home, and End keys move between tabs.

```js
const tray = FirstMateWindowShell.trayWindow({
  element: frame, header, title, body,
  tabs: [{id:'main', label:'Main', element:body}],
  onSelect: id => showView(id)
});
const windowController = FirstMateWindows.attach({
  element:frame, header, title, body:tray.body, host, name:'example'
});
const historyPanel = tray.register({id:'history', label:'History'});
historyPanel.append(historyView);
tray.select('history');
```

`panel(id)` returns a panel for additional trusted app content;
`unregister(id)` removes a tab. Selection hides inactive panels without
recreating their nodes, so drafts and media can survive a tab switch. The app
still owns its data loading, permissions, and lifecycle.

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
  mobileFullscreen: true,           // Default: phone viewport is full-screen, Close only
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

Clicking a minimized title bar, pressing Enter or Space on its title, or using
Restore returns to the previous mode, including its saved floating geometry or
dock width. Right-click and Alt+Space still open the placement menu.

On phone viewports (outer portal width at most 760px), all placements become full-screen
with only a padded Close control. Menus, move/resize gestures and minimize/maximize
are disabled. Set `mobileFullscreen: false` to explicitly opt out for a specialized
window. Narrow desktop iframes keep desktop controls.

The desktop right-side controls are:

| Current mode | Controls, left to right |
| --- | --- |
| Floating | Dock, Minimize, Maximize, Close |
| Docked | Dock opposite side, Minimize, Maximize, Close |
| Maximized | Dock, Float, Minimize, Close |
| Minimized | Float, Restore, Maximize, Close |

Click an open window's title, right-click the title, or press Alt+Space for the window menu, including
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

## Dock placement and motion

Click Dock to start on the right; subsequent clicks alternate left and right.
Right-click Dock for Left, Right, a separator, and the four corner placements.
`dock(side)` also accepts `top` and `bottom`; `state.dockSide` reports placement.
Dragging a floating header to a workspace edge previews the coordinated layout;
release commits it, moving away or pointer cancellation discards the preview.
Top/bottom edge centers produce horizontal docks; corners produce quarter docks.
Double-click the inward divider to swap adjacent docks, or exchange the dock with
the main workspace's remaining space and width. Divider arrows resize the dock.

Geometry and main content reservations transition together over 320 ms. Direct
pointer dragging/resizing follows the pointer without interpolation. Reduced
motion preferences disable animation. Project windows set `allowFullscreen:false`
to remove and reject the entire-screen mode while retaining workspace maximize.

Dragging a docked header detaches to its saved floating size after the pointer
moves, preserving the grab position and continuing the same gesture. Header
clicks and divider resizing do not detach. Initial floating sizes are bounded
to 72% of workspace width and 60% of usable height (subject to minimum sizes).
Near-workspace-sized saved floats are reduced on return; other user sizing is
preserved.
