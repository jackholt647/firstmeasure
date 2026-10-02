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
choose an existing project or lead and confirm a sales appointment. The server
chooses an available resource and the configured duration. Its authenticated
`POST /v1/appointments/organizations/:orgId/book` requires CSRF, the appointment
slots capability, and schedule/project editing permission. It checks the project
branch, acquires a capacity hold, and calls the existing scheduling domain writer.
The event ID makes retries for the same project/time idempotent. Existing hold and
domain-writer concurrency guarantees apply; this adds no distributed booking lock.

The same operation is published as `scheduling.appointment.book` with a project
target and typed `event_id`/`start_at` input. The assistant's
`open_scheduling_widget` tool only opens the dialog; it does not invoke a booking.

Verification: `appointment-booking.test.ts`, `appointment-booking-browser.test.mjs`,
the booking case in `assistant-api.test.ts`, and the publication suite.
