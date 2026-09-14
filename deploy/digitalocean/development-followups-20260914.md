# September 14 fixes — development only

Application commit/release: `73829c35e3d349eeaa8481a9ab82b801d86dda5e`.
Branch: `codex/september-14-bugfixes`, based on the September 10 follow-up branch.
No production activation, production data repair, image/template change, or
production database migration was performed.

## Scope and evidence

- **1M8-177:** QA feedback actions await initial project hydration and the correct
  embedded editor. PDF preparation does not prematurely submit the project before
  Fixed/Disputed responses are committed. Server-side correction routing respects
  the latest QA/manager rejection through queued/in-progress states, including VIP
  projects; a mismatched submitted scope is rejected. The earlier fix was included
  in the September 10 production release; the returned reports exposed additional
  failure paths, not simply an absent deployment. Read-only inspection of the Coal
  Creek report found draft/canonical feedback differences. Regression tests cover
  failed/stale loads, initial hydration, PDF preparation, VIP QA correction routing,
  durable draft/response handling, and concurrent decisions.
- **1M8-185:** Manual processing may proceed to pin-centered raster imagery when
  Google Building Insights returns no coverage. It retains the exact selected pins
  and does not substitute the address geocode. Authentication, rate-limit and server
  failures are not treated as missing coverage. Instant reports still require
  building insights. Pin modal now links to the existing permission-gated project
  details/cancellation controls. Tests use the reported pins and mocked provider
  responses; they do not establish that Google has usable raster imagery there.
  Missing height-map coverage remains a legitimate processing failure.
- **1M8-178:** Provider-scale normalization preserves saved technician fine-scale
  calibration instead of canceling it on reopen. Switching projects invalidates
  pending raster-load callbacks. Repeated reopen tests preserve calibration,
  offsets and rotation; the existing DSM projection test preserves geometry over
  repeated saves/reopens. This reproduces a reset path, but does not prove it caused
  every historical scale report. The already-completed Kellogg project was only
  inspected read-only; historical geometry was not repaired.
- **1M8-182:** Daily payroll TSV adds `original_technician_user`,
  `latest_technician_user`, and `qa_started_timestamp`. Original/latest are derived
  from chronological technician work history; QA start uses the earliest QA claim.
  Unknown original technician remains blank. Existing export columns, authorization
  and pay calculations are unchanged. Fixture export tests verify reassignment,
  correction work, QA timestamps and missing history.

## Validation

- Local TypeScript check, changed JavaScript syntax checks and repeated DSM
  save/reopen regression passed.
- Linux development build/type check passed; 23 focused tests passed with no
  failures/skips. These include actual API tests with isolated SQLite storage and
  frontend-function tests with mocked browser/provider boundaries.
- All nine changed application-source baseline hashes matched release `e35b884`
  on each development host before staging. Only the committed delta was overlaid
  on each host's existing runtime. Configuration and dependencies stayed in place.
- Compiled output was built on development compatibility and copied identically
  to development web/worker; source and compiled archive hashes were verified
  before activation. The worker queue was empty before its restart.
- Running development compatibility (`137.184.229.145`), web (`143.198.68.11`),
  and worker (`137.184.44.82`) all verified release `73829c3`, development data
  environment and the expected running directory. Previous `e35b884` directories
  are retained for rollback. Activation scripts included rollback on failed checks.
- Public `https://dev.1m8.ai/v1/health/ready` returned the exact new release with
  all dependency checks and enforced outbound safety. The development load
  balancer briefly returned 503 during web restart/reentry, then recovered.
- All seven edited browser assets served through `dev.1m8.ai` matched local
  committed source (normalizing CRLF/LF). No port-8031 demo was used.

Authenticated development-browser acceptance is pending staff login. Automated
regressions and deployed-source verification are not a claim that affected
production records have been repaired or that the reporting team has accepted
these fixes. Keep production status separate until an authorized rollout and
production checks; leave final completion to the reporting team.

Host-side staging/activation scripts and test output are under `/root/sep14-*`
and `/root/*sep14-dev.py`. Their local copies are in the ignored
`outputs/urgent-20260909/` workspace folder. No credentials were copied with the
release archives.
