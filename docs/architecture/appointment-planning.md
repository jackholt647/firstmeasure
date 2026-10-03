# Configurable appointment planning

The project Schedule tab and global Scheduling use `FirstMateBooking`. The project tab has one creation button and no sidebar. Existing calendar items and the detailed event editor remain available.

Departments classify an appointment independently of delivery and recurrence. `department_ids: []` explicitly means no department; multiple IDs mean the appointment appears in each selected department. Older events without this field retain their legacy Sales/Production classification. Scheduling groups collect departments for calendar filtering. Sales and Production are initial catalog entries backed by existing workforce roles and crew kinds, not exclusive appointment types.

The branch scheduling module's `appointment_catalog` contains departments, groups and presets. A preset is a configuration snapshot: title, departments, delivery flag, duration, arrival-window length, start interval, staffing requirements and optional recurrence. Advanced edits produce a Custom configuration. Named-assignee presets can leave the actual resource choice empty, requiring selection when booking. Company-settings permission gates catalog changes; optimistic revisions prevent silent overwrites.

Each staffing requirement scopes an eligible pool by department and people/crew category, then requires a count, everyone, a percentage (rounded up), or named subjects. All requirements must pass. Crew attendance optionally checks and reserves a percentage of the active roster as well as the crew unit. Zero checks only the crew's own calendar. Resource names/IDs come from the existing authenticated workforce service; requirements never grant access to foreign resources.

The planner reuses the availability engine's working hours, resource calendars, conflicts and travel checks. It looks for an actual duration-sized reservation inside each offered arrival window. Recurring bookings keep the same local start time and resource set, and must satisfy every occurrence. Recurrence is explicitly finite: 2–52 occurrences within two years. This bounds computation and avoids promising unverified future capacity. Existing recurrence APIs still manage the saved series and occurrences.

`arrival_window_start_at`/`arrival_window_end_at` preserve the customer window; `start_at`/`end_at` preserve the internal reservation. Recurrence shifts both sets of timestamps. `delivery` records intent only; no material list, order or delivery workflow is automatically created.

Authenticated routes under `/v1/appointments/organizations/:orgId`:

- `GET /catalog`, `PUT /catalog`: read/manage catalog.
- `POST /preview`: validate configuration and calculate availability without writing.
- `POST /book`: recheck all requirements and persist a booking/series. The original payload remains supported for older hosts.

Typed publications are `scheduling.appointment.catalog`, `.configure`, `.preview` and `.create`. The original `.book` contract remains compatible. Strict schemas live in `planning-contracts.ts`; services live in `planning.ts`. Booking requires schedule management, appointment capability and the correct project branch. PostgreSQL serializes configured bookings with an organization advisory lock and commits their records atomically. SQLite uses an in-process lock and a durable booking receipt; an interrupted save remains pending rather than being blindly repeated. Other legacy scheduling writers retain their existing concurrency guarantees.

The internal `appointment_bookings` receipt collection is not added to the generic browser collection API. Replays check the actor and full request fingerprint before returning the saved result.

Validation covers attendance thresholds, crew rosters, named selection, department combinations, arrival-window persistence, recurrence, retry safety, catalog revisions, optional projects and browser interaction. Public forms retain their existing contact collection and public endpoint boundary while sharing the calendar/time-slot component.


## Instant Full Org development defaults

New Instant Full Org development sandboxes seed seven presets: Sales (60 minutes, exact start), Installation (two consecutive full days, one production crew and its roster), Maintenance (60 minutes in a four-hour window, four quarterly occurrences), Repair (same timing without recurrence), Material deliveries (four-hour window and delivery flag), Company meeting (all people, 60 minutes), and Company sales meeting (all salespeople, 60 minutes). Durations, attendance and recurrence remain editable. Existing sandboxes with no saved catalog receive these defaults on reads; saved catalogs are preserved, including intentionally deleted defaults. Seeding occurs only during creation and never changes ordinary organization defaults.

`timing_mode: days` and `duration_days` (1–31) expose a date choice rather than hourly slots. Every consecutive local day must be open and the same resources must be available for its full working window; conflicts anywhere on each reserved day prevent booking. Saved events use local-midnight start and exclusive end, `all_day: true`, and nominal local-day duration. DST can change elapsed hours without changing the number of days. Closed days are not silently skipped. Overlapping recurring day spans are unavailable.

Preset `location.mode` supports project address, Company office, custom address or no location. Company office resolves current branch `contact.business_address`/`contact.address`, falling back to global contact data, at booking time. It uses the existing Company Settings address; no duplicate office record is created. A booking stores its resolved address and mode. Missing office addresses retain the Company office label and display a settings hint. Location is available outside Advanced for easy per-booking overrides.
