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
