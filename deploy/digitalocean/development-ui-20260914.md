# September 14 QA UI follow-up (186, 183)

Application release: `a139f54232663dcaa321025ea66316f322faebbd`.
Development only; no production activation or Git push performed.

- **1M8-186:** QA Quality summary, team and QA result tables display `90%+`,
  `80-90%`, `70-80%`, or `Less than 70%`. Boundaries use the unrounded score:
  90 belongs to the top band, 80 to the second, 70 to the third. Unknown/invalid
  values display a dash. These are display bands, not statistical confidence
  intervals. Underlying calculations, permissions, sample counts and exports
  remain unchanged.
- **1M8-183:** Both embedded and standalone QA review headers show P1/P2 beside
  VIP. The tag reuses `Projects.reportExpeditePriorityLevel`, preserving explicit
  priority overrides and the existing manual-priority, expedited and VIP rules.
  Standard P3 projects have no extra tag. Text labels supplement red/blue colors.

Validation: four new frontend regression tests pass (boundary/missing values,
rendered summary/team/QA HTML, priority rules, both review header call sites).
Twenty selected tests pass on the staged Linux development runtime, including
the existing feedback refresh and QA decision/concurrency suite. JavaScript
syntax checks, local TypeScript check and Git whitespace check pass.

Development staging started from each host's verified `73829c3` runtime and
overlaid only two committed browser scripts and two test files. Both changed
application baseline hashes matched before staging. Existing compiled output,
dependencies and host-specific configuration were preserved; compiled output
was hash-checked against the previous tested archive. No database migration,
provider configuration, billing, or autoscale changes were required.

Development roles: compatibility `137.184.229.145`, web `143.198.68.11`, worker
`137.184.44.82`, using their `firstmeasure-development-*` services. Guarded
activation checks the development data environment and release identity and
rolls back on failed readiness. Worker activation requires an empty job queue.
Previous `73829c3` directories remain available for rollback.

All three running development roles verified release `a139f54`. After the web
load balancer's restart/reentry interval, public development readiness returned
the exact release and development environment. Both edited scripts served through
`dev.1m8.ai` matched committed source (normalizing CRLF/LF).

Browser acceptance in an authenticated development session remains pending;
automated rendering tests are not a claim of manual browser acceptance. The
separate port-8031 demo was not used. The previous 177/185/178/182 fixes are
preserved in this development release.
