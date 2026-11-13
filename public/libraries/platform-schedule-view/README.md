# Platform Schedule View Library

`platform-schedule-view.js` owns reusable calendar surfaces for scheduling.

Load order:
1. `libraries/platform-scheduling/platform-scheduling.js`
2. `libraries/platform-schedule-view/platform-schedule-view.js`
3. App code such as `public/libraries/apps/project-request/app.js` or `public/libraries/apps/scheduling/app.js`

Main API:

```js
PlatformScheduleView.renderDailyTeam(container, {
  Scheduling: window.PlatformScheduling,
  config,
  users,
  projects,
  date,
  eventTypeId: 'sales_appointment',
  placementProject,      // optional; enables draft placement context
  draft,                 // optional: { start, user }
  liveTravel: false,
  readOnly: false,
  onDraftChange({ start, user }) {},
  onLiveTravelToggle(nextValue) {},
  onNavigate(deltaDays) {},
});
```

The library renders the daily team grid used for multi-salesperson appointment placement. It supports:
- read-only viewing
- placement mode with a single draft appointment
- unassigned row
- unavailable slot blocking
- existing appointment blocks
- live travel-time labels when Google Maps Distance Matrix is available

Future scheduling surfaces should use this library instead of duplicating the team/day grid in a feature script.

## Phone calendar controls and the event tray (FM-441)

`renderProjectRangeScheduler(container, { touchControls: true, ... })` turns on the phone
controls. The global Scheduling calendar and the project Schedule tab pass it on phones
(`max-width: 720px`) only; desktop and tablet calendars are unchanged.

- **Zoom:** hour rows start further out (32px). A two-finger pinch changes their height
  (18-120px) and keeps the time between the fingers under them, so a pinch that also moves
  scrolls in the same motion. The height is remembered on the device
  (`localStorage['fm:schedule:touch-slot-height']`) for every calendar.
- **Tap:** a tap on an empty spot places a one-slot event there (the whole day in Month or
  the all-day band) through `onDraftChange` + `onDraftCreateComplete(draft, { touchTap: true })`.
  A tap on an item is its click (`onEventClick` / `onDraftSelect`), which selects it. Holding
  still draws or moves as before, and a swipe still scrolls or changes the date.
- **Selection:** only the selected event shows translucent resize bars: above and below in
  the time grid, left and right on day bars. They resize straight away (no hold) through
  `onEventRangeChange` / `onDraftChange`.
- **Tray:** a host shows its own editor or details panel as the bottom tray:

  ```js
  document.body.appendChild(panel);
  const trayed = PlatformScheduleView.presentEventTray(panel, {
    anchor,           // the event's chip (or anything; the chip is found by eventId)
    eventId,
    onClose(){ ... }, // a tap on an empty spot of the calendar closes the tray through this
  });
  if (!trayed) positionAsPopover(panel); // not on a touchControls calendar
  ```

  The tray slides up (CSS animation) and the calendar scrolls, animated, so the event's
  bottom edge ends 10px above the tray. On a short screen the tray gets shorter (and scrolls
  inside) so the event still fits. Removing the panel ends the selection; a host that
  re-renders its panel presents the new one at once and it does not slide in again.
  `PlatformScheduleView.dismissEventTray(container)` closes it from code.
