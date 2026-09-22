# Browser navigation

FirstMate uses the browser History API without page reloads. The URL is durable application state; server data remains asynchronous content.

## API

```js
Portal.navigation.push({ tab: 'viewer', project: project.id, projectTab: 'money' });
Portal.navigation.replace({ moneyView: 'payments' });
Portal.navigation.backOrClose(['project'], {
  project: null,
  projectTab: null,
  projectView: null
});
```

`push` creates a Back-button destination. `replace` synchronizes the current destination. `backOrClose` exits the complete history segment owned by the supplied route key, including nested tabs and child views. Direct links, which have no in-app parent entry, are cleaned with replace. Feature code should not count entries or call `history.go()` itself; scope depth is tracked by the navigation library.

Route restoration is declarative:

```js
Portal.navigation.registerHandler('my-app', {
  priority: 300,
  match: (route) => route.tab === 'my_app',
  apply: (route) => showView(route.myView || 'overview')
});
```

Handlers run by priority. Parent shells use lower priorities than child views. Handlers must be idempotent and must not write routes while restoration is running.

During restoration, the URL is authoritative even when its requested tab is temporarily unavailable while project data, feature flags, or entitlements load. A temporary fallback may be rendered, but it must not replace the requested route; reapply the requested tab after dependencies resolve.

For ordinary tab strips, use `Portal.navigation.bindTabs()` or follow the same contract through the app host bridge.

For a new routed feature, the compact controller API owns registration,
writes, restoration, and teardown together:

```js
const route = Portal.navigation.createController('inventory-item', {
  keys: ['inventoryItem', 'inventoryView'],
  params: {
    inventoryItem: { history: 'push' },
    inventoryView: { history: 'replace' }
  },
  apply: (url) => renderItem(url.inventoryItem, url.inventoryView)
});

route.write({ inventoryItem: item.id }); // automatically pushes from schema
route.replace({ inventoryView: 'details' });
route.close({ inventoryItem: null, inventoryView: null });
```

App route parameters belong in `firstmate-apps-manifest.js`. The runtime
registers those schemas automatically, so an ordinary `navigation.write()`
uses push or replace according to the manifest. A modal registered through
`Portal.modals.register()` can opt into the same behavior with
`route: { key, value, patch, clear }`.

Route parameters are scoped to the app that declares them. The manifest runtime
derives that scope from `route.parent` plus `portalTabId` or the project's
`projectTab`. When a parent tab or project subtab changes, the navigation owner
removes registered child parameters that are no longer in scope in the same
history write. Shared keys remain valid when any declaring app owns the current
surface.

On portal boot, `Portal.navigation.reconcile()` normalizes registered values and
removes stale out-of-scope parameters with replace before session and feature-app
restoration. Query parameters unknown to the navigation catalog are left intact
for server returns and external integrations. `onboardingMode` is a replace-only
presentation key. `channels` keeps the shared branding and save pipeline while
rendering a Channels workspace sample instead of a report;
`home_improvement` renders a lightweight generic company workspace sample.

When no `tab` is present, the portal opens the first visible app in the rendered
sidebar order. App-level `defaultHome` hints do not override the top-level portal
order.

The project Money workspace uses `moneyView` for `overview`, `invoices`,
`recurring`, `expenses`, `receipts`, `commissions`, and
`take_payment`. Opening a receipt pushes `receipt`; next/previous receipt uses
replace, and closing the viewer uses `backOrClose()`. The global Receipts tab
uses the same `receipt` key. Invoice email confirmation and the generate form
are transactional state and are not written to browser history.

The Scope Template editor uses `scopeTemplateView` for `details`, `boards`, `scheduling`, `developer`,
`automations`, `todos`, `checklists`, `documents`, `materials`, `events`,
`notifications`, `communications`, `resources`, `fields`, `calls`, `transitions`,
`workflows`, `portal`, `payments`, `other`, `commissions`, and `assistant`. `automations`
is the trigger explorer; `events` is for calendar requirements. Opening a section
pushes history with `sub=project_scopes`, `settingsView=editor`, and
`settingsEntity=scope:<id>`. Cross-links include `scopeArtifact`, or
`scopeAutomation` plus `scopeEventFocus`, so Back restores the source section.
Selecting an artifact replaces `scopeArtifact`. `scopeArtifactFilter` (`all`,
`conditional`, `inactive`) and `scopeEventFilter` (`all`, `connected`, `unused`,
`actions`, `documents`, `todos`, `events`, `materials`, `checklists`,
`notifications`) replace the current location. Search text, edit forms, and
technical disclosures are transient UI state.

## Route hierarchy

Feedback (`tab=feedback`) mounts the same workspace as Settings → Feedback.
Its `feedbackView` key selects `responses` (the app default), `delivery`, or
`workflow` with push history. Settings retains its existing `sub=feedback`
and `settingsView` routes. Feedback starts in the app menu and can be pinned
to the sidebar with the existing app placement controls.

1. `tab`: portal app
2. `project`, `contact`, `user`, `pin`, `day`, or another entity/workspace key
3. `projectTab` or `sub`: parent workspace tab
4. Nested view keys such as `projectView`, `settingsView`, `scopeTemplateView`, `scheduleView`, `proposal`, `proposalMode`, `moneyView`, `reportView`, `document`, or `form`
5. Replace-only presentation keys such as `date`, `sort`, `filter`, `density`, `photo`, and `projectFullscreen`

## Choosing history behavior

Use **push** when a user would say “I went to…”: another app, project, contact, major workspace tab, existing entity editor, or substantial modal.

Use **replace** for view synchronization: search, filter, sort, dates, pagination while typing, fullscreen, preview device, or next/previous items in an already-open viewer.

Use **no route** for confirmations, menus, tooltips, unsaved form fields, upload pickers, selection state, and transactional callback cleanup.

## Required tests for new routed surfaces

- Directly loading the URL renders the correct parent shell immediately.
- Back and Forward restore the visible app, modal, and nested tab.
- Restoration does not create a new history entry.
- Refresh does not replay modal entrance animation.
- Slow data leaves stable chrome/skeletons rather than closing and reopening the surface.

Run `npm run test:navigation` from `public/v1`. It exercises push/replace,
Back restoration, modal ownership, and rejects direct History API writes in
feature apps.

## Customer communications

Communications (`tab=chat`) owns `communicationsView` (`inbox`, `lists`, `followups`, `history`, `center`, `scripts`, `setup`). There is no separate Calls sidebar app. Legacy `tab=calls` URLs normalize centrally to `tab=chat&communicationsView=lists`, including old URLs carrying the Inbox view, without adding a Back step. `communicationsFilter` replaces the current route. `communicationsEntry` identifies a list entry; legacy `callQueue` / `callIndex` links are restored as a best-effort selection without dialing.

Within the Communications inbox, `chatFilter` (`open`, `mine`, `unclaimed`, `snoozed`, `closed`) and `chatChannel` (`all`, `email`, `sms`, `call`, `webchat`) replace the current route. `chatConversation` pushes the selected native conversation; its mobile Back control closes that history-owned surface through `backOrClose`.

`customerCall` identifies the ambient customer-call workspace. It can accompany a project route such as `tab=viewer&project=…&projectTab=comms&commsView=calls`. Opening or restoring it never establishes phone media. Closing uses navigation ownership through `backOrClose`; minimizing is transient. The call runtime stays mounted when a view unmounts.

Channels profile inspection uses `channelProfile` (user identifier) together with
`channelProfileChannel` (parent conversation identifier). Opening the full profile
pushes these keys; the mini profile card remains transient. The Channels instance
restores the panel after its conversation loads and closes through `backOrClose`.

### Shared windows

`public/libraries/window-manager/window-manager.js` now owns window geometry and
chrome for conversations and huddles. The app adapters continue to own history:
`channelWindow`/`channelPinned` are scoped to `channelsOverlay`, while
`huddleWindow`/`huddlePinned` adjust an already active call. `huddleFullscreen`
remains supported for older links. Restoring a route never starts or joins a call.
When a route omits call-window state, an existing independent call keeps its state.
