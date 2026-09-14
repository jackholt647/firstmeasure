# 1M8-184: staff Tracking pilot design

Status: implemented and tested locally in development on September 14, 2026.
Not deployed to the shared development cluster or production; feature is off by default.

## Scope

One Tracking tab in measure/internal. All history, cross-account matches, training
events, review decisions and pilot access controls belong here, not scattered
across Users, QA and Tutorials. Full internal Admins have access by default.
Other users require an explicit individual grant; manager/QA/team roles must
not implicitly inherit access. Only full Admins can grant/revoke access.
Viewing privileges and being included in collection are separate concepts.
Jack confirmed collection is for all staff; individual enablement restricts viewing only.

## Evidence and signals

- Store authenticated account, event time (UTC), normalized IP, a one-way session
  reference, coarse browser context, staff/training status at event time and the
  server-verified course/attempt/project identifiers when applicable.
- Capture session establishment/first observed session, bounded activity samples,
  training start, exam start and successful exam/project submission. Label first
  observed activity honestly; it is not necessarily the login time.
- Higher-priority review: training/exam IP was previously observed on another
  established technician/QA account. Show the prior and current observations,
  matching accounts and timestamps. Exact-IP history can be searched separately.
  Do not count an association established only *after* the exam as prior history.
- Lower-priority review: new IP for this account, IP change during an attempt,
  or near-concurrent observed activity from different networks. Sampling cannot
  establish uninterrupted simultaneous use.
- Never classify an entire country, employer or network as suspicious. Shared
  offices, carrier NAT and VPN exits are important false-positive explanations.
  Exact IPv4/IPv6 normalization matters; network-prefix matches are not exact-IP
  matches. No geolocation provider, covert fingerprinting or automatic sanctions.
- Admin impersonation/support sessions must be marked and excluded from ordinary
  cheating flags. No passwords, raw cookies, session tokens, exam answers or full
  request URLs/bodies are retained.

## One central interface

1. Review signals: explainable signals prioritized within each 50-observation page;
   this is not a global precomputed inbox. Needs review, explained/shared
   network, or dismissed, with reviewer and timestamp. Never a “cheater score.”
2. People/history: search a user or exact IP; paginated event timeline, date and
   activity filters, cross-account matches. Display timezone explicitly, including
   a Manila option for the Philippines team.
3. Training/exams: attempt timeline with start/submission IP and prior account
   associations. Unknown/missing collection periods are visible, not “clean.”
4. Access/pilot: Admin-only individual viewer grants and collection status.

## Implementation constraints from the code inspection

- Platform auth has verified session context; legacy actor_email/role headers or
  request fields are not acceptable attribution or authorization sources for this
  feature. Enforce access using the authenticated identity and server-side grants.
- Exam start exists in Node internal legacy actions. Some tutorial/editor actions
  still run through PHP editor.php and _tutorials.php. A login-only Node hook is
  insufficient: trace and instrument the actual successful submission boundary,
  with a private authenticated bridge for PHP-origin events if necessary.
- Requests traverse the load balancer, NGINX and sometimes Node's compatibility
  proxy. Derive the visitor IP by walking a configured trusted proxy chain from
  the socket peer; never trust the leftmost forwarded header or public CF header
  unconditionally. Unknown provenance produces a coverage gap, not a guessed IP.
- Shared PostgreSQL events/indexes, not per-droplet files. Indexed lookups by
  account/time, IP/time and attempt; deduplicate bounded activity buckets across
  workers. Avoid every-request storage writes and client-triggered notification
  floods. Collection failure must not prevent login, work or exam submission.
- Proposed retention: 90 days with scheduled bounded expiry and matching review
  evidence expiry. No historical reconstruction from unrelated logs by default.
- Feature off until the additive schema, proxy configuration and pilot policy are
  ready. Local fixtures first; production activation remains a separate release.

## Required tests before Done in Dev

Authenticated Admin/granted viewer/ungranted manager/QA/customer/disabled user;
revocation and CSRF; forged actor and forwarding headers; IPv4-mapped IPv6 and
invalid/missing proxy chains; trusted multi-hop production and local chains;
successful versus failed exam submissions on the actual PHP and Node paths;
prior versus later cross-account association; shared office, VPN/NAT and admin
impersonation; retries and concurrent multi-node ingestion; bounded retention,
pagination and filtering with hundreds of staff fixtures; recording failure must
not block ordinary workflows; one-tab UI and HTML-escaping/access isolation.

## Development setup and release boundary

The feature is `STAFF_TRACKING_ENABLED=1` only in an environment deliberately
configured for it. Leaving this unset keeps all Tracking routes/UI off. It does
not opt individuals in or out of collection. Production activation is a separate,
authorized rollout; see [the September 14 production record](../deploy/digitalocean/production-tracking-20260914.md)
for its current state and verification evidence.

1. Use the existing isolated development database and storage configuration.
   Run `node --experimental-sqlite --import tsx src/scripts/staff_tracking_initialize.ts --initialize-development`
   from `public/v1` before enabling the feature. PostgreSQL tables/indexes are
   additive and shared; production refuses the local SQLite fallback. This command
   refuses production. No existing users, training records or rewards are migrated.
2. Set `STAFF_TRACKING_TRUSTED_PROXIES` to the **verified** immediate proxy/LB chain
   (comma-separated exact IPs/CIDRs) on Node. Do not blindly trust all forwarded
   headers, public clients, or an obsolete VPC range. An incomplete private chain
   records an unknown IP. A local test uses `127.0.0.1/32`.
3. PHP submissions require curl, `STAFF_TRACKING_ENABLED=1`, a random bridge secret
   of at least 32 characters shared with the local compatibility Node process,
   and `STAFF_TRACKING_BRIDGE_URL=http://127.0.0.1:<compatibility-port>/v1/private/staff-tracking`.
   Configure these via protected service/FPM environment, never checked-in secrets.
   Node uses `STAFF_TRACKING_BRIDGE_SECRET`; the exact route verifies a short-lived
   HMAC receipt independently of the ordinary legacy proxy guard.
4. Enable collection on web/compatibility runtimes together. General activity is
   sampled at the public Node entry, not double-recorded on the compatibility proxy.
   Node successful training/exam starts and PHP successful submissions have separate
   receipts. Existing unsupported draft/reject start actions are not repaired by this
   feature; successful PHP decision submissions can still be captured.
5. Full internal Admins get the Tracking tab automatically. Grant/revoke other active
   staff under Tracking → Viewing access. Neither customer Admin roles nor ungranted
   managers/QA can view it. Review writes and grants require CSRF. Disabled users are denied.

Collection is best effort: bounded queues (32 per process), 5-minute activity
sampling/deduplication, 90-day searchable history, hourly bounded expiry. PHP receipt
timeout is 750ms; failures never undo exam submission. Ingestion failures are logged;
the UI counters describe only its serving process since startup, not fleet-wide health.
No backfilled history, automated blocking, notification spam, geolocation, payroll
decisions or claims that an IP identifies a person. Support sessions are excluded
from ordinary signals. Comparisons are capped at 2,000 representative prior
account/IP/attempt/status observations and 10,001 recent source rows each for the
account and IP, explicitly marked when limited. New-IP claims are suppressed when
that evidence is incomplete; each signal
shows up to 20 matching observations. Retention bounds also apply to review evidence.

## Verification performed

- Unit tests: mapped IPv4/IPv6, forged forwarding, trusted multi-hop chains, missing
  provenance, prior versus later associations, expired evidence, impersonation and
  same-attempt IP changes.
- Real application tests: Admin/ungranted/granted/customer access, CSRF, immediate
  revocation, disabled users, collection for ungranted trainees/QA, signed receipt
  integrity and retry deduplication, notes, pagination, 400-account comparisons.
- Actual Node project/test start actions, failed-start exclusion, actual PHP test
  completion and its signed receipt, failed/non-completed submission exclusion.
- Isolated PostgreSQL: 500 associated staff, 16 concurrent duplicate receipts,
  indexed lookups and retention expiry.
- Headless Chrome: actual Tracking JS against real authenticated local APIs,
  history/training, access grant/revoke, hidden tab for ungranted trainee,
  desktop/mobile layout and no page errors. The host shell is a test fixture, not
  the shared dev portal. Screenshots under `outputs/staff-tracking-184/`.
- TypeScript check/build, PHP/JS lint, and existing Prices/internal-permissions/
  manager-review regression suites.

Tests: `node --experimental-sqlite --import tsx --test --test-force-exit tests/staff-tracking.test.ts`;
`node tests/run-embedded-postgres.mjs tests/staff-tracking-postgres.test.ts`.
The integration test needs PHP curl. A Windows CLI with no php.ini can set
`PHP_CURL_EXTENSION` to its installed php_curl.dll. Set
`TRACKING_BROWSER_EXECUTABLE` to an installed Chrome/Chromium executable to include
the browser checks. These variables affect the test harness only.
