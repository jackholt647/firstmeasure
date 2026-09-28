# Shared date and time picker

`date-time-picker.js` is the single dependency-free implementation for date,
time, and local date/time form popups. Edit this file to change every app.
Open `preview.html` to review all three modes and a modal example.

## Integration

The library automatically handles existing and dynamically inserted
`input[type=date]`, `input[type=time]`, and `input[type=datetime-local]` fields.
No per-app initialization is needed. The original input remains the source of
truth: names, values, selectors, typed entry, form submission, required/min/max/
step validation, and existing event handlers are preserved. Applying a changed
value dispatches bubbling `input` and `change` events once each. Cancellation
does not mutate the field. Local date/time strings are never converted to UTC.

The popup uses a shadow root for CSS isolation and the browser top layer where
available. It lives inside the nearest dialog to respect native modal inertness.
Detached, disabled, or retyped inputs dismiss an open picker. Space, F4, or
Alt+Down opens it; Escape cancels; Tab stays inside it; calendar arrow keys,
Home/End and PageUp/PageDown navigate dates. Number fields permit exact times,
including seconds and fractional seconds when the source field allows them.
Month/day labels and 12/24-hour display use the active formatting locale. UI
strings use PlatformLanguage with English fallbacks; dedicated translated
catalog entries have not been generated yet.

Optional API: `FirstMateDateTimePicker.open(input)` and `.close()`.
`data-native-picker` explicitly opts a field out. Do not use it for ordinary
application forms. Repeated loading is harmless.

## Audited coverage (September 28, 2026)

No reusable custom form date/time picker was found. Scheduling's existing
month/year calendar-view navigator is separate from form inputs and retained.

- Channels: scheduled messages, reminders, task deadlines.
- Scheduling and project scheduling: events, recurrence, equipment windows,
  appointment confirmations.
- Sales, Calls, Chat, CRM, action items, field visits: follow-ups and snoozing.
- Settings: business hours, appointment hours, payroll anchors, owner dates.
- Money, invoices and payroll: dates and receipt times (including seconds).
- Documents, document widgets/workflows, custom fields, training: generated
  date/date-time fields, signatures, schedules and release dates.
- Equipment: work-order scheduling.
- Legacy internal tools: shifts, payroll, QA, manager reviews, leads,
  dashboard tasks, API expiry, bonus offers, analytics and campaigns.
- Legacy sales: list filters and both embedded and standalone lead viewers.

Nine PHP entry points load the same file with a filemtime cache version:
portal, mobile, customer portal, customer preview, hosted sites, canvassing,
internal management, sales, and standalone sales lead. All 58 canonical app
manifests prepend it as a dependency, covering independently embedded apps as
well. Add it once in the shell of any new standalone host. Retired files under
`unused` and native operating-system controls are not rewritten.

## Verification

From the repository root:

```
node public/v1/scripts/date-time-picker-e2e.mjs
```

Uses the existing playwright-core dependency and Chrome (`CHROME_PATH` can
override the executable). Exercises real form values/events, cancellation,
focus restoration/trapping, min/max/required/step, leap days, second/fractional
precision, 24-hour locales, native and application dialogs, outside dismissal,
dynamic fields, type changes, removal, read-only/opt-out fields, mobile bounds,
and all 58 manifest dependencies. Screenshots are written to ignored
`output/date-time-picker/`. No authenticated/live-service data is needed.

This change is implemented locally; it has not been deployed. Real-device iOS
and Android WebView checks remain separate from the Chrome browser coverage.
