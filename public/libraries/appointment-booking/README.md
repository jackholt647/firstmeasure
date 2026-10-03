# Appointment booking

`availability.js` owns the public and staff calendar, mobile day strip, and time
slots. Hosts supply transport and submission; the picker never saves a booking.

```js
target.classList.add('fm-availability');
target.innerHTML = FirstMateAvailability.markup({ submitLabel: 'Book appointment' });
const picker = FirstMateAvailability.mount(target, {
  loadAvailability: async date => ({ slots: await fetchSlots(date) }),
  onChange: slot => { /* null clears a stale selection */ }
});
// On upstream input changes: picker.refresh(); on removal: picker.destroy().
```

Slots use `available`, `start_at` (or public `start`), and `label`. Requests carry
a generation token, so changing dates or removing the widget invalidates stale
responses. The surrounding form owns the submit action. Public lead embeds keep
their original form-scoped endpoints, contact fields, branding and credential-free
requests; changing the address refreshes availability.

Load `booking.js` to call `FirstMateBooking.open({orgId, projectId?, onBooked?})`
from any authenticated portal surface. It lazily loads the shared picker. Staff
can choose a project or lead with the shared searchable selector, or book without
a project and link one later from the calendar event editor. The server
chooses an available resource and the configured duration. Its authenticated
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
