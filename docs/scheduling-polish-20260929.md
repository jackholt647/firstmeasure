# Scheduling release polish — September 29, 2026

UX pass over the global Scheduling tab (`public/libraries/apps/scheduling/app.js`),
the project Schedule tab (`public/libraries/apps/project-schedule/panel.js`) and
the shared renderers (`public/libraries/platform-schedule-view/platform-schedule-view.js`).
Found by reading the code and driving both tabs in Chrome (desktop 1440/1100 px
and a 390 px phone) against seeded projects: sales appointments, grouped
production work with dependencies, deliveries, locked equipment, unscheduled
work and free calendar events.

Status: **done** = fixed in this pass; **later** = recorded, not changed.

## Global header

| # | Issue | Status |
|---|---|---|
| H1 | Sales / Production / Other toggles were solid red pills, identical to the active view button, so filters and the current view read as the same thing. | done — outlined check chips with each category's calendar color |
| H2 | The toggles disappeared in Timeline, so the header shifted between views. | done — shown in every view |
| H3 | Timeline ignored the toggles (and the people/lead-source filter) and had its own "Shown" menu duplicating Sales/Other. | done — Timeline obeys the header toggles and filter; the menu now only narrows Production to labor / equipment / deliveries |
| H4 | Views were a loose row of separately bordered buttons; the project tab uses compact segmented controls. | done — segmented groups: navigation, calendar views, scheduling views |
| H5 | Header ‹ / › moved the Timeline by one invisible day, and there were two Today buttons. | done — arrows page the Timeline a screen at a time, Today scrolls to today; the Timeline's own Today button is hidden when the host provides one |
| H6 | The Timeline title was the static word "Timeline". | done — shows the visible month range and updates while scrolling |
| H7 | On phones, choosing a view or month in the header menus did nothing: the outside-tap handler did not recognize the shared `prs-mobile-*` menus, closed them and re-rendered before the tap landed. | done |

## Timeline (shared Gantt renderer)

| # | Issue | Status |
|---|---|---|
| T1 | Opened at the oldest item, leaving today and upcoming work off the right edge. | done — opens with today a quarter of the way in, or on the nearest work when nothing is scheduled near today |
| T2 | Scroll position reset after every save, add, filter or reload. | done — viewport remembered per timeline (`stateKey`) across re-renders |
| T3 | Container pointer listeners were added on every render and never removed. | done — replaced, not stacked |
| T4 | Weekend shading covered Sunday + Monday while the header marked Saturday + Sunday. | done |
| T5 | All-day drags snapped to UTC midnight (previous evening in US time zones); clicking the right half of a day scheduled the next day. | done — local-midnight snapping; clicks pick the day under the pointer |
| T6 | Bars drifted an hour against the day grid after a DST change. | done — positions use local wall-clock time |
| T7 | Day ticks read "17 T"; month labels scrolled out of view; wide zooms had no hour ticks. | done — "Thu 17", sticky month labels, hour ticks from 480 px/day, today marked in the header |
| T8 | Truncated row titles had no tooltip. | done |
| T9 | Finishing a link drag could open the source item's editor; a vertical wobble on a bar saved an unchanged range. | done |
| T10 | Add-row buttons were unlabeled "+" icons. | done — "Add work item" / "Add section" |
| T11 | A cancelled touch gesture on an unscheduled lane could schedule it on a later pointer-up. | done — pointercancel / lost capture abandon the drag |
| T12 | The zoom slider was replaced mid-drag (the whole toolbar re-rendered on every tick). | done — toolbar kept across internal re-renders |
| T13 | The right rail sat beside the Timeline, duplicating its unscheduled rows. | done — hidden in Timeline; the Timeline uses the full width |
| T14 | No way to see all of a project's work at once. | done — "Fit" zoom; project timelines open fitted |
| T15 | Resource grouping put sales appointments under "Unassigned" when the rep is not a workforce resource. | done — people holding visible appointments get their own lanes |
| T16 | Phone layout: the 248 px label column (inline) overrode the mobile width rule. | done — 150 px on narrow hosts |
| T17 | Empty state rendered Today/zoom controls with no handlers. | done — only host controls remain |
| T18 | Free calendar events (no project) never appear on the Timeline. | later — needs a project-less row group and a save path |
| T19 | Linking is disabled in Resource grouping; no keyboard access to bars; no virtualization for very long ranges. | later |

## Parity: global vs project Schedule tab

| # | Issue | Status |
|---|---|---|
| P1 | Same view called "Timeline" globally and "Gantt" in the project tab. | done — "Timeline" (terminology key unchanged) |
| P2 | Project Timeline showed two Today buttons; its arrows moved a hidden anchor date. | done — one Today; arrows page the Timeline |
| P3 | Locked production items could be moved in the project Timeline (global blocks them). | done |
| P4 | Project Timeline showed equipment items when equipment scheduling is off (its calendar hid them). | done |
| P5 | Project Timeline zoom leaked between projects and was lost on re-render. | done — each project opens fitted; zoom and scroll persist while working |
| P6 | The project event editor is mostly read-only compared to the global editor. | later — needs a shared editor, too large for a polish pass |

## Bugs found along the way

| # | Issue | Status |
|---|---|---|
| B1 | Schedule groups (e.g. "Roof replacement") were listed as "Waiting" in the global Production rail even when every item in them was scheduled. | done |
| B2 | Timed events without an `all_day` flag (older data, demo seed appointments) rendered in the all-day band of Day/Week/Routing. | done — inferred as timed when they start off midnight and last under a day |
| B3 | Project sales tile showed the raw user id instead of the assignee's name. | done |
| B4 | Project production tiles: the crew picker overflowed the card and cut titles to a few characters. | done — picker sits under the title |
| B5 | Project confirmation actions dispatched the calendar refresh on `document` (listeners are on `window`) and reported failures through a nonexistent `Portal.toast`. | done |
| B6 | Global `refreshActiveScheduleSurface()` had no Timeline branch, and the editor could not anchor to Timeline bars. | done |
| B7 | `modeLabel`, passed by every host, is ignored by the Gantt renderer. | later (harmless) |
| B8 | New UI strings are not yet in the localization catalogs (they fall back to US English). | later — run the catalog migration with the next localization pass |
