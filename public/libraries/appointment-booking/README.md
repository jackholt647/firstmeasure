# Appointment booking

`availability.js` owns the public and staff calendar, mobile day strip, and time
slots. Hosts supply transport and submission; the picker never saves a booking.

```js
target.classList.add('fm-availability');
target.innerHTML = FirstMateAvailability.markup({ submitLabel: 'Create event' });
const picker = FirstMateAvailability.mount(target, {
  loadAvailability: async date => ({ slots: await fetchSlots(date) }),
  onChange: slot => { /* null clears a stale selection */ }
});
// On upstream input changes: picker.refresh(); on removal: picker.destroy().
```

Slots use `available`, `start_at` (or public `start`), and `label`. Requests carry
a generation token, so changing dates or removing the widget invalidates stale
responses. The surrounding form owns the submit action. The public forms embed
(`libraries/forms-embed`) mounts this picker for its appointment block and loads
slots from the form-scoped, credential-free availability endpoint.

Load `booking.js` to call `FirstMateBooking.open({orgId, projectId?, onBooked?})`
from any authenticated portal surface. It lazily loads the shared picker. On a
phone (720 px or narrower when it opens) the dialog is a stepped flow: pick an
appointment type (or Custom, or New type when the person can manage the
catalog) → search for the project, or type an address and use it without one
(skipped when the caller passes `lockProject`) → duration, day and time with
**Create event**. Previous/Next sit in the footer, and the Advanced sheet (this
appointment's name, location, departments, staffing, recurrence) opens from the
top right of any step; it never saves a type. New type is its own full-height
**New appointment type** sheet (`configuration.js` `typeMode`): a type name and
the type's settings, never an appointment name. **Save type** adds it to the
catalog for everyone, then the booking continues with that type chosen; Cancel
leaves the appointment as it was. Each type says whether it **needs a project**
(`requires_project`, a switch in Settings and in the New appointment type sheet;
sales and production types do by default, and a type saved before the switch
existed is read that way when it belongs to the sales or production department
or counts as sales or project work, unless it meets at the company office). For
such a type the Project step offers neither No project nor a bare address, and
the server refuses to book it without a project (`appointment_project_required`).
The New project step's address uses Google's own address suggestions (the
portal's Places library; the list is moved into the dialog), and its name and
phone share a row with email under them, as in the project's details tray. With
New project showing, the footer keeps Previous on the left and New project with a
narrow Next on the right. Help marks (`?`) are buttons beside a label,
never inside it, and open their bubble on tap (hover too, with a mouse). Wider screens keep the one-page form. Pass `steps:true|false`
to force either layout. Staff
can choose a project or lead with the shared searchable selector, or book without
a project and link one later from the calendar event editor. The server
chooses an available resource and the configured duration. Each time shows how many could go then (`free`). A
person booking a type nobody can staff yet (no crews or subcontractors, no one of its department: the preview's
`staffing[].unstaffed`, and `teams` counts groups and outside companies) still sees every time and books it
unassigned; a note above the times says so, with a Setup pill that plays the workforce setup where it can play (the
dialog closes for it and opens again after). A customer's booking (forms) never takes an unassigned time (GP-85). Its authenticated
`POST /v1/appointments/organizations/:orgId/book` requires CSRF, the appointment
slots capability, and schedule/project editing permission (schedule management
is required for appointments without a project). It checks the project
branch, acquires a capacity hold, and calls the existing scheduling domain writer.
The event ID makes retries for the same project/time idempotent. Existing hold and
domain-writer concurrency guarantees apply; this adds no distributed booking lock.

The same operation is published as `scheduling.appointment.book` with a project
or organization target and typed `event_id`/`start_at` input. The assistant's
`open_scheduling_widget` tool only opens the dialog; it does not invoke a booking.

Verification: `appointment-booking.test.ts`, `appointment-booking-browser.test.mjs`,
the booking case in `assistant-api.test.ts`, and the publication suite.

The shared `FirstMateProjectSelector.mount(host, {orgId, projectId?, onChange})`
component lives in `libraries/project-selector/project-selector.js`. It uses the
existing bounded server search (12 results), debounces typing, discards stale
responses, supports arrow keys/Enter/Escape, and keeps six recently selected IDs
in user/organization-scoped session storage. `value`, `setDisabled()` and
`destroy()` allow reuse by other forms without loading every project.

`configuration.js` provides presets and independent department, delivery, recurrence, staffing and arrival-window controls. See [appointment planning](../../../docs/architecture/appointment-planning.md) for the catalog and engine contracts.
