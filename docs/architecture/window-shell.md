# Shared entity window layout

Project and Contact windows use `FirstMateWindows` for placement, docking,
minimization and close controls, and `FirstMateWindowShell` for their content
layout declaration and tab styling.

On mobile viewports (760px and narrower), all shared windows default to full-screen
with only a padded Close button. This covers the portal top bar. Docking, moving,
resizing, minimizing and maximizing are unavailable, including when restoring a
desktop placement. The manager uses the outer portal viewport even when the
controls live in a narrow iframe. Apps may explicitly opt out with
`mobileFullscreen: false`; omitting the option enables the mobile default.

Project headers place the title at top left and Close at top right, with multiple
tabs below. A lone tab is hidden. The legacy floating report Close is suppressed
when shared chrome owns the window. Form layout responds separately to available
content width: narrow desktop docks stack a full-width form above the map without
switching to phone ordering. Mobile location entry reserves visible map space;
later ordering steps use the form. Overview keeps one contact/address heading.

## Opening a layout

```js
await Portal.modules.request.openProject(project, {
  layout: {
    panes: [{ tab: 'map', weight: 40 }, { tab: 'photos', weight: 60 }],
    tray: 'notes',
    tabs: true,
    tabStyle: 'underline'
  }
});

await Portal.modules.contacts.open(contact, {
  layout: {
    panes: [{ tab: 'projects', weight: 35 }, { tab: 'media', weight: 65 }],
    sidebar: true,
    tray: null
  }
});
```

Pane order is left to right. Positive finite weights are normalized; omitted
weights are equal. Ratios apply to the app workspace, excluding the sidebar,
tray and dividers. Pane minimum widths can constrain ratios on narrow screens.
Users can resize dividers after opening. Contact dividers also support arrow keys.

`tray` selects one available right tray, or `null` closes it. Project tray IDs
are `notes`, `messages`, `activity` and `agent`, subject to existing capabilities
and the separate-messages setting. `tabs`
shows or hides the tab bar. `tabStyle` is `underline` (default) or `pills`.
`sidebar` shows or hides a declared persistent sidebar; it cannot create one.
Unavailable tabs/trays, duplicate tabs, invalid weights and unknown options
throw before applying the requested layout.

An existing project window accepts a layout-only `openProject` request and
retains omitted layout properties. A new entity open restores default chrome
and closes trays before applying its requested layout. Existing tab/photo open
options remain supported. Contacts also expose `await contacts.setLayout(layout)`
for changing the current window while retaining form and pane DOM state.

## Declaring a window

`FirstMateWindowShell.mount({element, header, identity, tabs, sidebar, panes,
trays, tabStyle, headerRows})` accepts application-owned DOM nodes. `tabs` and
`sidebar` can be null. The pane adapter supplies `available()` and `apply(panes)`;
the optional tray adapter supplies `available()` and `select(idOrNull)`.
The returned shell supplies `validate`, `apply` and `reset`.

Contacts inject their details column as the persistent sidebar and use the same
two-row title and tab header as Projects. Projects declare no persistent sidebar:
Overview and other apps retain their own content rails as described in
[project content ownership](project-content-layout.md). This does not restore
the removed project left-region override or module injection contracts.

`localPanes` retains in-document tab nodes (Contacts). Project panes retain their
existing isolated documents and share the portal's transport. Changing ratios
or order retains open panes. Project trays sit to the right of the entire
workspace, outside all split panes.

Contact pane wrappers own the content inset: 18px on desktop and 12px on mobile.
Tab renderers mount inside that wrapper without duplicating its padding. The
same inset applies to single and split layouts and subsequent contact panes.

Project-to-contact navigation goes through the retained window's validated
`openContact` bridge. The owning portal loads Contacts if needed, opens the
contact window, and then closes the source project. Split project panes forward
through their own bridge. Loading failures preserve the source project.

## Optional Contact trays

Contacts currently declare no domain trays. Trusted application code can add one:

```js
const unregister = await Portal.modules.contacts.registerTray({
  id: 'example',
  label: 'Example',
  available: ({ contact, orgId }) => canReadExample(contact, orgId),
  mount(node, context) {
    return mountExample(node, context); // synchronous handle with optional destroy()
  }
});
await Portal.modules.contacts.setLayout({ tray: 'example' });
```

Renderers own resource authorization and data access. Layout options grant no
permissions. Tray instances survive switching or hiding; closing or changing
contacts destroys them. `available` is reevaluated for the next contact on open
and on capability changes. Unregistering destroys that tray. AI and notes domain
integration for Contacts can use this contract when implemented.

Validation: `cd public/v1 && node --test tests/window-shell-browser.test.mjs
 tests/window-manager-browser.test.mjs tests/project-trays-browser.test.mjs`.
