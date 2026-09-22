# Appointment confirmations

Asks the customer to confirm an appointment by email and/or text ahead of time,
and flags the appointment as unconfirmed on every schedule until they answer.

## Flow

1. **Plan** — saving a scheduled appointment calls `syncAppointmentConfirmation`
   from the project-event write path (`platform/api.ts`). It reconciles a queue
   row in `appointments.sqlite` and stamps `event.confirmation` back onto the
   event. Moving, unscheduling, or deleting the appointment re-times or
   withdraws the request automatically.
2. **Send** — a 60s tick (`runConfirmationTick`) claims every due row and sends
   through `sendProjectEmail` / `sendProjectSms`, the same path the Comms tab
   uses, so the message threads onto the project with the org's default sender.
3. **Listen** — `handleInboundConfirmationResponse` runs from
   `comms/notifications.ts:onInboundCommunication`, the single funnel for
   inbound SMS and email. A reply reading as yes/no resolves the request; an
   ambiguous reply is left open for a human.
4. **Or click** — every message carries a link to `/v1/appointments/public/:token/app`,
   a branded confirm page.

## Send timing

`schedule.mode` covers the phrasings people actually use:

| mode | meaning | fields |
| --- | --- | --- |
| `morning_of` | fixed local time on the appointment's own day | `time_of_day` |
| `time_of_day` | same computation, different default time | `time_of_day` |
| `before_offset` | rolling offset before the start ("an hour before") | `offset_minutes` |
| `days_before` | fixed local time N days earlier ("previous afternoon") | `days_before`, `time_of_day` |

Fixed-time modes clamp into `earliest_hour`..`latest_hour` so nothing fires at
3am; `before_offset` is deliberately literal. Nothing is ever scheduled after
the appointment starts.

## Queueing and dedup

Each row carries a `group_key` of organization + contact + local calendar day,
and every row in a group shares one `token`. A customer with three appointments
on Tuesday gets **one** message listing all three, and one reply confirms all
three. `claimDueConfirmationGroups` leases a whole group at once, so a crashed
tick retries rather than double-sending.

## Visibility

Some companies don't want, say, their salespeople to know an appointment is
still unconfirmed. `visibility.mode: "permission"` restricts confirmation state
to holders of `permission.view_appointment_confirmation` (plus any permission
sets listed in `visibility.role_ids`). When hidden, the appointment renders
exactly as it did before the feature existed — no dashed border, no status, no
panel. The rule lives in `canViewConfirmations` (server) and
`PlatformScheduling.confirmationVisible` (client); every surface asks one of
those two rather than checking permissions itself.

## Where it surfaces

- Dashed border + marker on schedule chips — `platform-schedule-view.js`
- Confirmation panel with "mark confirmed" / "send now" — `apps/project-schedule/panel.js`
- Status pill + per-appointment config editor — `apps/scheduling/app.js`
- Company defaults, templates, and visibility — `apps/settings/company.js`,
  Scheduling tab
- Customer's own status in the portal — `publicProjectScheduleEvent`

## Scope templates

A scope template's per-list `schedule.confirmation` block seeds
`event.confirmation` on generated events (`materials/storage.ts`), so a template
can declare "appointments of this kind always ask the customer to confirm"
without anyone configuring each one. An explicit value on the event wins, and an
answer already given is never overwritten.

## Work events

`appointment.confirmation.requested`, `appointment.confirmed`, and
`appointment.confirmation.declined` are emitted for automations to bind to.

## Tests

`npm run test:appointments` (backend + timing/parsing units),
`npm run test:appointments:frontend` (syntax contract).
