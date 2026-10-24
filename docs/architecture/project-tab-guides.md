# Project tab guides: pills, order and first-open tutorials

What a project window's tab strip shows beside App experience
([app experience](app-experience.md)). App experience decides whether someone
has a tab; nothing here hides or shows one.

## Organization data: order and pills

`project_tabs` in the organization's global data, returned with the app-flag
state (`GET /organizations/:org/app-flags`, `project_tabs`) and written by an
operator with `PUT /organizations/:org/app-flags { project_tabs }`
(`normalizeProjectTabsInput` in `platform/app_flags.ts`). Like `app_placements`
it is not writable through `/global`.

```json
{ "order": ["project.map", "project.measurements", "project.photos"],
  "pills": { "project.photos": "new", "project.docs": "coming_soon" } }
```

- `order`: project tab app ids. Listed tabs come first, in that order; every
  other tab keeps its default order after them.
- `pills`: `new` shows "New" until the person first opens the tab;
  `coming_soon` always shows "Coming soon". The tab-promos replacements
  (`apps/tab-promos/project.js`) keep their own `promoBadge`.

A configuration sets it as data (`settings.project_tabs`); see
`signup-sandbox/configurations/mvp-platform.ts`.

## Personal: what a person has opened

`seen_tabs` on `/me/preferences`: app ids whose "New" pill the person cleared
by opening the tab. Only tabs carrying a `new` pill are recorded, so a pill
added later still shows to everyone.

## Browser

`public/libraries/tab-guides/tab-guides.js` (`window.FirstMateTabGuides`,
loaded by `portal/index.php`): `order(apps)`, `pill(appId)` and
`opened({ appId, tabId, container, isActive })`, which the project window
(`apps/project-request/app.js`, `syncProjectModalAppActivation`) calls when a
tab becomes active; it returns true when a pill cleared so the host redraws its
tabs. `ProjectViewer.renderTabs` (`portal/scripts/project_viewer.js`) draws a
tab's `badge` with `badgeKind` (`pv-tab-badge--new`, `--coming_soon`); on
icon-only tabs a New pill becomes a dot beside the icon.

A tab's label is terminology: the Project tab is `scope.project_tab`, renamed
per organization in the `variable_mappings` branch module
(`labels.scope.project_tab`).

## First-open tutorials (minimal hook, to be replaced)

A separate guided-experience library will replace this. Everything
tutorial-specific is listed here so it can absorb or remove it:

- In `tab-guides.js`: `registerTutorial`, `tutorialFor`, `play`, `replay`,
  `hasSeenTutorial`, `tutorials`, the internal `normalizeTutorial`, `engine`,
  `syncHelp` (the `.fm-tab-help` replay button) and the tutorial branch of
  `opened`.
- The `seen_tutorials` preference (`/me/preferences`, `SEEN_ID_PATTERN` in
  `platform/api.ts`, shared with `seen_tabs`).
- `Tutorial.run(steps, { onEnd })` and the step tooltip in
  `apps/tutorial/app.js` (z-index above the project window, `data-fmr-ignore`).
- A tab may also declare `tutorial` on its app entry.

Format: `{ id, tab: <app id>, steps: [{ target, title, text, placement }] }`.
It plays the first time the person opens the tab, is remembered by `id` once a
step has shown (change the id to play it again for everyone), and the help
button replays it. No tab ships a tutorial.

## Tests

`tests/tab-guides-browser.test.mjs`, the app-flag and preference cases in
`tests/capabilities.test.ts`, and `tests/signup-sandbox-mvp-platform.test.ts`.
