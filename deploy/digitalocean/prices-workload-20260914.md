# 1M8-176 workload controls — development follow-up

Application release: `e36c4d5a7311b8ba42b67c3526a4d5d11af84f81` on
`codex/september-14-bugfixes`. Production is unchanged.

Ben's September 10 kickback requested control of the schedule and peak/max waits,
not only the pricing coefficients. Full internal Admins can now edit:

- Off-peak and peak workload waits (before the delivery buffer).
- Delivery buffer and maximum total standard turnaround; 480 minutes is 8 hours.
- Daily Pacific-time ramp-up start, peak start/end and wind-down end.

The form separates pricing from workload, previews the next 24 hours of waits
and rush prices, and saves both under the existing shared revision/authorization
guard. The schedule is the same each day, in America/Los_Angeles (DST-aware), not
a weekly staffing calendar or a measured live queue. Existing small deterministic
daily variation remains. Maximum includes the buffer but not the existing
30-minute-per-additional-commercial/multifamily-structure allowance. Rush delivery
windows and standard base prices are unchanged. Standard minimum/maximum labels,
due windows and the production deadline use the configured standard values.

Validation rejects unordered/overnight schedule intervals, peak below off-peak,
maximum below peak plus buffer, and off-peak below 3 hours (preserves rush tier
ordering). Original values remain defaults, including the 06:00/10:00/14:00/17:00
schedule. Legacy stored pricing records receive only missing workload defaults
in memory, without a write or revision change. Old-browser writes missing these
fields fail rather than resetting the schedule.

## Evidence

- TypeScript check/build and all eight pricing/workload tests pass on Linux.
  Tests exercise admin authorization/CSRF, validation, conflicting revisions,
  cross-app settings visibility, quote/charge/free-expedite consistency, legacy
  stored records, old-client rejection, an 8-hour cap, structure increments and
  summer/winter Pacific schedules. API tests use isolated SQLite storage.
- Browser test of the real Prices script in an isolated loopback fixture verified
  loading, editing an 8-hour scenario, changing ramp start, live 480-minute preview,
  saving and reloading. This fixture mocks the portal shell/session/persistence;
  it is not an authenticated full PHP portal or PostgreSQL integration test.
- Staging checks confirmed all four changed application files matched prior
  development release `a139f54` on each host. Only committed source/tests were
  overlaid on each retained host runtime. The compatibility-built dist is identical
  across roles and verified against the archive before activation. Configuration,
  dependencies and unrelated fixes remain in place.
- Development hosts: compatibility 137.184.229.145, web 143.198.68.11, worker
  137.184.44.82, with their existing firstmeasure-development-* services. Activation
  checks development isolation, release ID and current process directory; worker
  queue must be empty. Prior code is retained and activation rolls back on failure.
- All three running development roles verified `e36c4d5`. Public development
  readiness returned that exact release and development environment after normal
  load-balancer reentry. Served `prices.js` matched committed source; the running
  quote endpoint returned revision 0 with unchanged default 4–7-hour standard and
  fixed rush windows. No shared setting was saved to test this deployment.

No live production or shared development pricing settings were changed during
this work. Preview/save fixtures use isolated test data. Authenticated development
portal acceptance remains pending a staff session.

## Future production rollout constraint

Do not save the expanded configuration until **all** pricing-consuming production
roles are updated: the old strict schema cannot read new workload fields. The
deployment needs the signed replacement release channel as usual. Before settings
are saved, code can roll back to the prior release. After new fields are persisted,
a code-only rollback to the old schema is not safe; use a forward fix or explicitly
reviewed configuration rollback. Preserve the current pricing values and revision;
do not blindly reset defaults. No production rollout is authorized by this record.
